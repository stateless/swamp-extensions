#!/usr/bin/env python3
"""Build a review-canvas doc-mode spec from on-disk markdown files and
optionally (re)serve it. Removes the per-use spec-assembly boilerplate
(strip frontmatter -> assemble spec -> restart server on the same token).

Python 3 stdlib only (matches server_py.txt).

Examples
--------
# single doc, build spec only
serve_docs.py --outdir /path/wd --name review \
  --file notes/design.md

# two docs, build + (re)serve on the same token (archives any prior save first)
serve_docs.py --outdir /path/wd --name app-list --title "RFC review" --serve \
  --port 8802 --token "$TOKEN" \
  --file docs/0001.md::"PROJECT-0001 (services)" \
  --file docs/0002.md::"PROJECT-0002 (architecture)"

One --file => single-doc spec ("content"); many => multi-file ("files").
--serve shuts down any server answering on the port with the given token,
archives an existing <name>.json save (so it is never clobbered), launches
server_py.txt detached, health-checks, and prints the open URL.
"""
import argparse, json, os, re, socket, subprocess, sys, time, urllib.request


def strip_frontmatter(text):
    return re.sub(r"^---\n.*?\n---\n", "", text, count=1, flags=re.S)


def slug(s, fallback):
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s or fallback


def sidecar_for(src):
    """The webcanvas-edited sidecar co-located with the source: foo.md -> foo.webcanvas.md."""
    return re.sub(r"\.md$", ".webcanvas.md", src) if src.endswith(".md") else src + ".webcanvas.md"


def build_spec(files, name, title, scale, outdir):
    docs = []
    for item in files:
        path, _, ftitle = item.partition("::")
        src = os.path.abspath(path)
        side = sidecar_for(src)
        # Resume from the sidecar if the webcanvas has edited it; else load the source.
        read_from = side if os.path.exists(side) else src
        with open(read_from) as fh:
            body = strip_frontmatter(fh.read())
        docs.append((ftitle or os.path.basename(src), body, src, side))
    spec = {"name": name, "title": title or name, "mode": "doc",
            "optionScale": [s.strip() for s in scale.split(",")], "outDir": outdir}
    if len(docs) == 1:
        _, b, src, side = docs[0]
        spec["content"], spec["path"], spec["sidecar"] = b, src, side
    else:
        spec["files"] = [{"name": slug(t, f"doc{i}"), "title": t, "content": b,
                          "path": src, "sidecar": side}
                         for i, (t, b, src, side) in enumerate(docs)]
    return spec, sum(len(d[1]) for d in docs)


def main():
    ap = argparse.ArgumentParser(description="Build (and optionally serve) a review-canvas doc spec from markdown files.")
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--name", required=True, help="safe slug; becomes file basenames")
    ap.add_argument("--title", default="")
    ap.add_argument("--scale", default="approve,revise,reject")
    ap.add_argument("--file", action="append", default=[], metavar="PATH[::Title]",
                    help="repeatable; one => single doc, many => multi-file")
    ap.add_argument("--serve", action="store_true")
    ap.add_argument("--port", type=int, default=8800)
    ap.add_argument("--token", default="")
    ap.add_argument("--skill-dir", default=os.path.dirname(os.path.abspath(__file__)))
    ap.add_argument("--restart", action="store_true",
                    help="force a full restart instead of in-place reload (needed when server_py.txt itself changed)")
    ap.add_argument("--force", action="store_true",
                    help="proceed even if an unprocessed <name>.json save exists (archives it). Without this, --serve refuses to reload over an unread save.")
    a = ap.parse_args()

    if not a.file:
        sys.exit("error: at least one --file is required")

    # Absolute outDir so saves land here regardless of the server's CWD (the
    # relative-outDir + foreign-CWD split-brain that buried saves under the skill dir).
    a.outdir = os.path.abspath(a.outdir)

    spec, chars = build_spec(a.file, a.name, a.title, a.scale, a.outdir)
    specpath = os.path.join(a.outdir, f".review.{a.name}.spec.json")
    with open(specpath, "w") as fh:
        json.dump(spec, fh, ensure_ascii=False, indent=0)
    kind = "multi" if "files" in spec else "single"
    print(f"spec: {specpath} · {kind} · {chars} chars")

    if not a.serve:
        return

    base = f"http://127.0.0.1:{a.port}"
    # guardrail: never silently bury an unprocessed human save. Refuse to reload
    # while a <name>.json exists unless --force (which then archives it).
    existing = os.path.join(a.outdir, f"{a.name}.json")
    if os.path.exists(existing) and not a.force:
        sys.exit(
            f"refusing to reload: unprocessed save at {existing}\n"
            f"  read it first:  diff_save.py --outdir {a.outdir} --name {a.name} --file ...\n"
            f"  then fold the edits + commit (human delta), and re-run with --force.")
    if os.path.exists(existing):  # --force given
        ts = time.strftime("%H%M%S")
        os.rename(existing, os.path.join(a.outdir, f"{a.name}.SAVED-{ts}.json"))
        print(f"archived prior save -> {a.name}.SAVED-{ts}.json")

    # Is a server already up on this port + token?
    running = False
    if a.token:
        try:
            urllib.request.urlopen(f"{base}/ping?t={a.token}", timeout=3)
            running = True
        except Exception:
            running = False

    # --restart forces a full restart (needed when server_py.txt itself changed).
    if running and a.restart:
        try:
            urllib.request.urlopen(f"{base}/shutdown?t={a.token}", data=b"", timeout=3)
            time.sleep(1)
        except Exception:
            pass
        running = False

    if running:
        # in-place reload (SIGHUP-equivalent): no restart, token/tab survive
        try:
            urllib.request.urlopen(f"{base}/reload?t={a.token}", data=b"", timeout=3)
            print("reloaded in place (no restart) — refresh the tab")
        except Exception as e:
            print("reload failed, restarting:", e)
            running = False

    if not running:
        server = os.path.join(a.skill_dir, "server_py.txt")
        subprocess.Popen(["python3", server, "--spec", specpath, "--bind", "0.0.0.0",
                          "--port", str(a.port), "--token", a.token],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1)

    try:
        print("ping:", urllib.request.urlopen(f"{base}/ping?t={a.token}", timeout=3).read().decode())
    except Exception as e:
        print("ping failed (check .review.%s.server.log):" % a.name, e)
    print(f"open: http://{socket.gethostname()}:{a.port}/?t={a.token}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Diff a review-canvas save against the source markdown files — the read-back
side of the doc-review loop (serve_docs.py builds the spec; this shows what the
human changed). Stdlib only.

Reads <outdir>/<name>.json and, for each saved file, matches it (by the slug of
its --file Title — the same rule serve_docs.py uses) to a source PATH, strips
the source YAML frontmatter, and prints a unified diff plus any per-file
verdict/comment. Replaces the ad-hoc inline-python diff blob.

Example
-------
diff_save.py --outdir /path/wd --name app-list \
  --file docs/0001.md::"PROJECT-0001 (services)" \
  --file docs/0002.md::"PROJECT-0002 (architecture)"
"""
import argparse, difflib, json, os, re, sys


def strip_frontmatter(text):
    return re.sub(r"^---\n.*?\n---\n", "", text, count=1, flags=re.S)


def slug(s, fallback):
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s or fallback


def main():
    ap = argparse.ArgumentParser(description="Diff a review-canvas save vs its source files.")
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--file", action="append", default=[], metavar="PATH[::Title]",
                    help="same --file args as serve_docs.py; maps saved slugs to sources")
    ap.add_argument("--context", type=int, default=1, help="unified-diff context lines")
    a = ap.parse_args()

    save_path = os.path.join(a.outdir, a.name + ".json")
    try:
        save = json.load(open(save_path))
    except (OSError, ValueError) as e:
        sys.exit(f"no readable save at {save_path}: {e}")

    print(f"# save: {save_path}")
    print(f"savedAt: {save.get('savedAt', '?')} | overall verdict: {save.get('verdict', '') or '-'}")
    if save.get("notes"):
        print("notes:", save["notes"])

    # slug -> source path, using the same slug rule as serve_docs.py
    src = {}
    for i, item in enumerate(a.file):
        path, _, title = item.partition("::")
        src[slug(title or os.path.basename(path), f"doc{i}")] = path

    # single-doc saves mirror content at the top level
    files = save.get("files")
    if not files:
        files = [{"name": next(iter(src), "doc"), "content": save.get("content", ""),
                  "verdict": save.get("verdict", ""), "comment": save.get("comment", "")}]

    any_change = False
    for f in files:
        nm = f.get("name", "")
        saved = f.get("content", "") or ""
        v = f.get("verdict", "") or "-"
        c = f.get("comment", "") or ""
        head = f"\n===== {nm}  (verdict: {v}{'; comment: ' + c if c else ''}) ====="
        path = src.get(nm)
        if not path:
            print(head + "\n  (no --file mapping for this slug — skipped)")
            continue
        orig = strip_frontmatter(open(path).read())
        if saved.strip() == orig.strip():
            print(head + "\n  no change")
            continue
        any_change = True
        print(head)
        for ln in difflib.unified_diff(orig.splitlines(), saved.splitlines(),
                                       fromfile=f"source:{os.path.basename(path)}",
                                       tofile="saved", lineterm="", n=a.context):
            print(" ", ln)
    if not any_change:
        print("\n(no content changes vs source)")


if __name__ == "__main__":
    main()

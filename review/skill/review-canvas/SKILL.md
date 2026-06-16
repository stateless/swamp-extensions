---
name: review-canvas
description: >
  Serve a local web form for human-in-the-loop review and collect the human's
  structured decisions from disk. Three uses: gate a long candidate list
  (curation grid with configurable option-scale + comments), review/edit
  generated markdown docs (editor left, live preview right, multi-file
  directory listing), or get an approve/revise/reject verdict before
  publishing something. Triggers: "review form", "gate this list", "human
  review canvas", "approval form", "let me review it in the browser".
---

# Review Canvas

Serve `server_py.txt` (bundled in this skill dir; Python 3 stdlib only, no
pip) on the LAN; the human gates/edits in their browser at their own pace
while you keep working; you read the structured result back from disk.
**Detached collaboration surface, not a blocking prompt.**

Canonical source: `https://github.com/stateless/swamp-extensions/tree/main/review`
(this is the standalone-skill packaging of the `@stateless/review` swamp
extension — swamp users should use the model instead).

**Scope: secure private networks ONLY.** The URL token is an abuse guard,
not internet auth. Never expose the port publicly.

## The loop

```bash
OUT=/path/to/workdir            # where spec + results live
TOKEN=$(python3 -c "import uuid;print(uuid.uuid4().hex)")
# 1. write the spec (see reference below)
#    $OUT/.review.<name>.spec.json   — "outDir" inside it must equal $OUT
# 2. serve, detached
nohup python3 <skill-dir>/server_py.txt \
  --spec "$OUT/.review.<name>.spec.json" \
  --bind 0.0.0.0 --port 8800 --token "$TOKEN" >/dev/null 2>&1 &
# 3. health-check, then give the human the URL
curl -s "http://127.0.0.1:8800/ping?t=$TOKEN"        # {"ok":true,...}
echo "open: http://$(hostname):8800/?t=$TOKEN"
```

4. **Wait/poll** — the human clicks Save whenever. `<name>.json` appears in
   `$OUT` (poll its mtime, or just check when the user says they saved).
5. **Collect** — read `$OUT/<name>.json` (structure below). For doc mode,
   diff the saved markdown against your originals to pick up their edits.
6. **Shutdown** — `curl -s -X POST "http://127.0.0.1:8800/shutdown?t=$TOKEN"`.

Re-serving with the same spec prefills from the last save (resume). To
rediscover a lost session: `ps ax | grep server_py` — the cmdline shows
`--spec`, `--port`, and `--token`.

## Helper: serve_docs.py (build spec from files + reserve)

For **doc mode over on-disk markdown files**, `serve_docs.py` (bundled, stdlib only)
removes the per-use boilerplate — it strips YAML frontmatter, assembles the spec
(single `content` for one file, `files[]` for many), and optionally restarts the
server on the **same token** (archiving any prior `<name>.json` save first so a
human edit is never clobbered):

```bash
python3 <skill-dir>/serve_docs.py --outdir "$OUT" --name app-list --serve \
  --port 8802 --token "$TOKEN" --title "RFC review" \
  --file docs/0001.md::"PROJECT-0001 (services)" \
  --file docs/0002.md::"PROJECT-0002 (architecture)"
```

One `--file` => single-doc spec; many => multi-file. Omit `--serve` to only
(re)build the spec. Use this instead of hand-rolling the strip-frontmatter +
spec-assembly + restart dance each iteration.

**Read back with `diff_save.py`** (the inverse — what the human changed). Same
`--file` args; it reads `<name>.json`, matches each saved file to its source by
slug, and prints a unified diff + per-file verdict/comment. Use it instead of an
ad-hoc inline-python diff:

```bash
python3 <skill-dir>/diff_save.py --outdir "$OUT" --name app-list \
  --file docs/0001.md::"PROJECT-0001 (services)" \
  --file docs/0002.md::"PROJECT-0002 (architecture)"
```

The loop end-to-end: `serve_docs.py` (publish) → human edits + Save →
`diff_save.py` (read back) → fold edits into the source + commit (human delta,
no agent trailer — the blame ledger) → `serve_docs.py --serve --force` (reload in place).

**Guardrail (don't bury an unread save).** `serve_docs.py --serve` **refuses to
reload while an unprocessed `<name>.json` exists** — it errors and tells you to
`diff_save.py` it first. Once you've folded + committed the edits, pass
`--force` to archive the save and reload. This closes the hole where an
agent-side reload silently archives a save the human made but the agent never
read. (Banner protects the human's tab; this guardrail protects the agent side.)

### Sidecar mode + client autosave (doc mode)

`serve_docs.py` records, per file, the **absolute source path** plus a co-located
**sidecar** (`foo.md` → `foo.webcanvas.md`). The webcanvas edits the *sidecar*,
never the source:

- **Source = `foo.md`** (read-only input the agent authors). **Sidecar =
  `foo.webcanvas.md`** (what the canvas writes). Fold = `diff foo.md foo.webcanvas.md`.
- **Client autosave**: the page POSTs edited content to `/autosave` every 5s while
  dirty — persisted to the sidecars only (no json/md/log churn). Manual **Save**
  still writes the structured `<name>.json` + verdicts + log *and* the sidecars.
- **Resume**: on (re)build, `serve_docs` loads the sidecar if it exists, else the
  source — so canvas edits survive reloads/restarts.
- **outDir is now absolute** (`os.path.abspath`), fixing the split-brain where a
  relative outDir + a foreign server CWD buried saves under the skill dir.
- Sidecars are real on-disk files next to the sources; track or gitignore per
  project. The source is never mutated by the canvas — that's the whole point.

## Files written to outDir on every Save

| File | What |
| --- | --- |
| `<name>.json` | structured result — the thing you read |
| `<name>.md` | readable render; doc single-file: the edited doc itself; multi-file: index table of verdicts |
| `<name>.<file>.md` | multi-file doc mode: each file's edited content — **diff these vs originals** |
| `<name>.log.md` | timestamped append-log of every save (history is never lost) |
| `.review.<name>.server.log` | server breadcrumbs (check on startup failure, e.g. port in use) |

## Spec reference

`list` mode — gate a long candidate list:

```json
{
  "name": "app-gate", "title": "App migration gate", "mode": "list",
  "outDir": "/path/to/workdir",
  "optionScale": ["keep", "decide", "drop"],
  "contexts": ["everyday", "dev", "system"],
  "instructions": "legend text shown in the bottom bar",
  "items": [
    {"group": "Backup", "name": "restic", "meta": "apt -> brew",
     "recommendation": "keep", "note": "fleet standard", "context": "system"}
  ]
}
```

- `optionScale` values render as radios; `recommendation` pre-checks one.
  Well-known values get semantic colors (keep/high/approve green,
  drop/reject red, decide/undecided amber/grey); others cycle a palette.
- `contexts` (optional) adds a per-item select; omit to hide it.
- Items group under `group` headings in input order.

`doc` mode — markdown editor left, live preview right:

```json
{
  "name": "release-review", "title": "Release notes review", "mode": "doc",
  "outDir": "/path/to/workdir",
  "optionScale": ["approve", "revise", "reject"],
  "files": [
    {"name": "brief", "title": "design-brief.md", "content": "# ...markdown..."},
    {"name": "notes", "title": "release-notes.md", "content": "# ..."}
  ]
}
```

- Single doc: use `"content": "..."` at the top level instead of `files`.
- Multiple `files` render a **directory listing** above the editor with a
  per-file verdict (when `optionScale` is set) + comment — the listing
  doubles as a checklist over the files.
- `optionScale` in doc mode also renders an overall verdict row in the
  bottom bar — that is your publish gate.
- Top-of-document YAML frontmatter (`---` fenced) renders as a dashed,
  labelled block in the preview; the page warns before close/navigation
  while edits are unsaved (since 2026.06.12.2).
- Editing aids (2026.06.12.3+): toolbar with bold/italic/strikethrough/code/
  link + the five CriticMarkup marks ({++add++}, {--del--}, {~~old~>new~~},
  {==highlight==}, {>>comment<<}); Ctrl/Cmd+B/I/E/K + Ctrl+Shift+X;
  Obsidian-style type-to-wrap (typing * _ ` ~ = [ ( with a selection wraps
  it — ** by typing * twice). The preview renders Critic marks (ins green,
  del struck, comment bubbles; plus ~~strikethrough~~ and ==highlight==
  markdown) — ask the human to mark up with tracked changes, then parse {..}
  marks from the saved markdown and apply/resolve them.
- Selecting text in the *preview* and hitting a toolbar button jumps the
  editor to the matching source run and formats it there (block-scoped via
  data-line stamps); a selection spanning a formatting boundary falls back
  to a hint.
- Editor spellcheck is on by default; the preview re-renders per-block on a
  700ms typing pause (only changed blocks touch the DOM) and scroll-syncs
  to the editor — large docs stay responsive (.7–.9).
- Doc mode is a fixed viewport column (the page never scrolls; only the
  editor/preview panes do), so the header can't cloak the toolbar (.9).
- File `content` must be inlined in the spec (read the source files and
  embed them when writing the spec JSON).

## Result shapes (`<name>.json`)

list: `{"notes": "...", "savedAt": "...", "items": [{"name", "group",
"meta", "disposition", "context", "comment"}]}` — diff `disposition`
against your `recommendation` to see what the human changed.

doc: `{"notes": "...", "verdict": "approve", "savedAt": "...", "files":
[{"name", "title", "content", "verdict", "comment"}]}` — single-file mode
also mirrors `content` at the top level.

## Git as the blame ledger (canvas = worktree, doc = main)

When the human reviews an agent-authored doc through this canvas, use git to
keep **human-edit vs agent-edit attribution** clean. Mental model: the tracked
doc (e.g. `docs/design/…md`) is **main**; the scratch canvas workdir
(`tmp/…`, gitignored) is a **worktree**. Edits happen in the worktree, then
merge back to main as commits.

Three-commit choreography:

1. **Baseline** — commit the agent's pre-review doc *with* the
   `Co-Authored-By: <model>` trailer.
2. **Human edits** — read `<name>.json` `content`, write it verbatim into the
   tracked doc (preserve frontmatter), commit **without** the co-author
   trailer. `git diff baseline..HEAD` is now the pure human delta; `git blame`
   attributes those lines to the human.
3. **Agent merge** — apply further agent changes, commit *with* the trailer.

**Trailer-presence is the attribution signal** — without it = human edits,
with it = agent edits. This is the one place to deliberately omit a
default co-author trailer. **Do not bundle** the human's saves and the agent's
next merge into one commit (even if asked as one step) — insert the human-only
commit between, or the blame separation is lost.

Protect the human's work: poll for `<name>.json` before every overwrite;
after consuming a save, rename it (`<name>.SAVED-HHMM.json`) so a stale file
isn't re-read as new; preserve inline CriticMarkup ({>>comment<<}, ==highlight==)
verbatim — they are the human's annotations.

## Caveats (learned the hard way)

- **Never test-POST `/save` against a live outDir** — it overwrites the
  human's real save (the append-log is the safety net).
- Kill by token/port, not name: `pkill -f server_py` from a shell whose own
  cmdline contains that string kills your shell. Prefer the `/shutdown`
  endpoint; fallback `fuser -k 8800/tcp`.
- Port already in use → startup dies; check `.review.<name>.server.log`.
- `name` must be a safe slug (`[a-z0-9][a-z0-9._-]*`) — it becomes file
  basenames.
- **Spec/content changes reload in place — no restart.** Standard unix service
  pattern: `kill -HUP <pid>` (or POST `/reload?t=<token>`) re-reads the spec from
  disk, so the port, `--token`, and any open tab survive. The open page polls
  `/ping` for a content version and pops a **"Source changed on disk — Reload"**
  banner (warning first if you have unsaved edits), so a reload never silently
  re-saves stale content. Only changes to `server_py.txt` itself
  need a true restart. `serve_docs.py --serve` auto-reloads when a server is
  already up on the port+token; pass `--restart` to force a relaunch (e.g. after
  editing `server_py.txt`). Saves persist across both.
- **Never shutdown+re-serve while the human has the form open with unsaved
  edits.** Resume restores only the last *clicked Save* — never in-flight
  typing. A restart also rotates the `--token`, invalidating the open tab, so
  the human silently loses unsaved work and must copy the textarea out and redo
  (where a stray paste/select can clobber a line). To iterate while they're
  active, **reuse the running server**; if a restart is unavoidable, pass the
  **same** `--token` so the open tab stays valid. Treat "test/serve again" as
  reuse-the-server, not restart-it, whenever a human may be mid-edit.
  (Servers from 2026.06.12.2 pop a browser leave-warning while edits are
  unsaved — a guard, not a substitute for this rule.)

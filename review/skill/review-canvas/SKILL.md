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
- File `content` must be inlined in the spec (read the source files and
  embed them when writing the spec JSON).

## Result shapes (`<name>.json`)

list: `{"notes": "...", "savedAt": "...", "items": [{"name", "group",
"meta", "disposition", "context", "comment"}]}` — diff `disposition`
against your `recommendation` to see what the human changed.

doc: `{"notes": "...", "verdict": "approve", "savedAt": "...", "files":
[{"name", "title", "content", "verdict", "comment"}]}` — single-file mode
also mirrors `content` at the top level.

## Caveats (learned the hard way)

- **Never test-POST `/save` against a live outDir** — it overwrites the
  human's real save (the append-log is the safety net).
- Kill by token/port, not name: `pkill -f server_py` from a shell whose own
  cmdline contains that string kills your shell. Prefer the `/shutdown`
  endpoint; fallback `fuser -k 8800/tcp`.
- Port already in use → startup dies; check `.review.<name>.server.log`.
- `name` must be a safe slug (`[a-z0-9][a-z0-9._-]*`) — it becomes file
  basenames.
- Spec changes need a server restart (shutdown + re-serve); saves persist
  across restarts.

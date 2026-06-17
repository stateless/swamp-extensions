# @stateless/review

A **human-in-the-loop review canvas** for swamp. An agent (terminal client,
workflow, or chat session) serves a local web form; the human gates, edits, or
approves at their own pace; the agent collects the structured result. A
collaboration surface, not a blocking prompt — `serve` returns immediately and
`collect` reads from disk later, even after the server has stopped.

## Three intended uses

1. **Curate a long candidate list** (`mode: list`) — an LLM produces 100
   candidates (app migration, resource pruning, security-finding triage,
   cleanup approvals); the human gates each with a configurable option-scale,
   an optional context select, and a comment. Beats pasting N decisions into
   chat.
2. **Review generated docs** (`mode: doc`) — markdown editor on the left,
   live preview on the right. The human edits free-form; the agent diffs the
   web-save against git/its own copy to pick up the changes. Pass `files:`
   to review **multiple docs in one session**: a directory listing renders
   above the editor with a per-file verdict + comment, so the listing
   doubles as a checklist over the files.
3. **Pre-publish gate** — `mode: doc` with an `optionScale` (e.g.
   `[approve, revise, reject]`) adds a verdict row. A workflow serves the
   artifact before pushing it anywhere public; `collect` returns the verdict
   the next step branches on. Human eyes before publish.

## Model

```yaml
type: "@stateless/review"
globalArguments:
  outDir: /srv/review        # where session artifacts land (the collab point)
  bind: 0.0.0.0              # default; private networks ONLY
  port: 8800
```

### Methods

| Method    | What it does |
| --------- | ------------ |
| `serve`   | Write the session spec, spawn the bundled Python-stdlib server **detached**, health-check it, record `session` (URL + token + pid + paths). Idempotent per `name` — a live session is reused; change the spec by re-running `serve` after `stop`, or bounce code with `restart`. |
| `status`  | Is the server alive? Has the human saved yet (file mtime)? Refreshes the `session` resource. |
| `restart` | Re-bake any `path`/`contentPath`-backed doc content from disk into the spec, then refresh the live canvas — **same URL/token/port**, open tabs keep working and show a source-changed banner. A live server is reloaded in place (`POST /reload`, no new pid); a dead one is respawned. Use after editing a served source file. To pick up new server **code** or clear a wedged server, `stop` first (then `restart` respawns). |
| `collect` | Read `<name>.json` from disk, summarize (per-disposition counts, or doc bytes/lines/verdict), record a `result` resource. Throws if the human hasn't saved. |
| `stop`    | Ask the server to exit via its token-authenticated `/shutdown` endpoint; falls back to a `/proc`-cmdline-verified SIGTERM. Artifacts stay on disk. |

Liveness and shutdown go over HTTP with the session token (identity = token +
session name), **not** pid signalling — model methods may run in sandboxed
runtimes where `/proc` is unreadable, and a token match can never target a
stranger's process.

### `serve` arguments

```yaml
name: app-gate            # slug; keys output files + resources
mode: list                # or doc
title: "App migration gate"
# list mode
items:
  - { name: restic, group: Backup, meta: "apt -> brew", recommendation: keep, note: "fleet standard" }
optionScale: [keep, decide, drop]      # list default; doc: optional verdict row
contexts: [everyday, dev, system]      # optional secondary select
# doc mode — single file:
content: "# Release notes\n..."        # inline markdown, or:
contentPath: /path/to/draft.md
# doc mode — multiple files (directory listing + per-file verdict/comment):
files:
  - { name: brief, title: "Design brief", path: docs/brief.md }
  - { name: model, title: "Platform model", path: docs/model.md }
instructions: "scale: keep=migrate, drop=skip"   # bottom-bar legend
port: 8801                # optional per-session override
```

Well-known scale values get semantic colors (keep/high/approve green,
drop/reject red, decide/undecided amber/grey, …); unknown values cycle a
palette.

## Durability

Every **Save** in the form dual-writes into `outDir`:

- `<name>.json` — structured result (what `collect` reads)
- `<name>.md` — human-readable render; single-file doc mode: **the edited doc
  itself**; multi-file: an index table of files + verdicts
- `<name>.<file>.md` — multi-file doc mode: each file's edited content
  (diff these against the originals)
- `<name>.log.md` — timestamped append-log: a save can never silently lose
  prior state

Reloading the form prefills from the last save (resume) — **only the last
clicked Save**, never in-flight typing; the page warns on close/navigation
while unsaved edits exist. Doc previews render YAML frontmatter as a styled
block.

Doc-mode editing aids: a toolbar (bold/italic/code/link plus the five
[CriticMarkup](https://fletcher.github.io/MultiMarkdown-6/syntax/critic.html)
marks — `{++add++}`, `{--del--}`, `{~~old~>new~~}`, `{==highlight==}`,
`{>>comment<<}`), Ctrl/Cmd+B/I/E/K shortcuts, and Obsidian-style
type-to-wrap (typing `*`, `_`, `` ` ``, `[`, `(` with a selection wraps it —
`**bold**` by typing `*` twice). The preview renders Critic marks visually
(insertions green, deletions struck red, comments as bubbles), so a human
can mark up a doc with tracked changes the agent then parses and applies.
The editor and preview scroll-lock together (proportional, wrap-safe;
toggle the **sync** checkbox in the toolbar to release them), and a
**change-rail** down the right edge drops one colour-coded, clickable tick
per Critic mark — click a tick to jump both panes to that change, selecting
it in the editor and flashing the block in the preview.
`collect`
additionally records the result into the swamp data model, so workflows
consume it with CEL:

```text
data.latest("<instance>", "result-<name>").attributes.verdict
data.latest("<instance>", "result-<name>").attributes.summary.keep
```

## Workflow sketch (publish gate)

```yaml
steps:
  - name: serve-gate        # serve the draft for human eyes
    method: serve           # mode: doc, optionScale: [approve, revise, reject]
  - name: collect-verdict   # later / next run — throws until the human saves
    method: collect
  - name: publish
    when: data.latest("review", "result-release-notes").attributes.verdict == "approve"
```

## Security scope

**Secure private networks only.** The per-session URL token
(`http://host:port/?t=<token>`) guards against drive-by/CSRF on the LAN — it
is *not* internet-grade auth, and it is deliberately visible (the operator
must open the URL; it is also recorded in the `session` resource). Do not
port-forward or expose the listener publicly. The server is Python stdlib
(`http.server`), single-session, single-purpose.

## Requirements

- `python3` (stdlib only — no pip packages) on the host running the model.
  The bundled server ships as `server_py.txt` (plain Python; the registry
  restricts non-TS asset extensions) and is run as `python3 <path>`.
- Linux procfs only for the last-resort verified-kill fallback; normal
  liveness/shutdown is HTTP-token based and procfs-free.

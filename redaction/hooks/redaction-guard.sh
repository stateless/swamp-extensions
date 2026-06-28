#!/usr/bin/env bash
# redaction-guard.sh — Claude Code PreToolUse guard for Bash tool calls.
#
# Two-stage classifier: (A) is this Bash command a PUBLISH/egress action? If not,
# allow instantly (no scan). (B) If yes, scan the EGRESS SURFACE (the public
# mirror tree / the command text) with the redaction CLI and DENY on a hit.
#
# Wired via .claude/settings.json: { hooks: { PreToolUse: [ { matcher: "Bash",
# hooks: [ { type: "command", command: "<this script>" } ] } ] } }.
#
# Contract: stdin = the PreToolUse JSON; emit a permissionDecision:"deny" JSON to
# block, or nothing to allow. FAIL-OPEN on infra errors (missing deno/CLI) — a
# broken guard must never brick work; CI is the non-bypassable floor. FAIL-CLOSED
# only on an actual detected identifier.

set -euo pipefail

DENO="${REDACTION_DENO:-/home/swamp/.deno/bin/deno}"
CLI="${REDACTION_CLI:-/home/swamp/SWAMP/extensions/models/redaction/cli.ts}"
DENY="${REDACTION_DENYLIST:-/home/swamp/SWAMP/llm-catalog-data.private/forbidden-identifiers.txt}"
MIRROR="${REDACTION_MIRROR:-/home/swamp/swamp-extensions}"
MIRROR_MARK="${REDACTION_MIRROR_MARK:-swamp-extensions}"

allow() { exit 0; }                              # no output → proceed
deny()  {                                        # block with a reason
  jq -n --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}

input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)"
[ -z "$cmd" ] && allow                           # not a Bash command we can read

# Stage A — is this a publish/egress action? (rsync→local-mirror is staging, not
# egress; the subsequent `git push` is the gate point.)
PUBLISH_RE="git[[:space:]]+push|swamp[[:space:]]+extension[[:space:]]+push|swamp[[:space:]]+issue[[:space:]]+(submit|ripple|comment)|gh[[:space:]]+(pr|release)"
echo "$cmd" | grep -qE "$PUBLISH_RE" || allow     # not a publish → allow instantly

# Infra present? If not, FAIL-OPEN (don't brick on a broken guard).
{ [ -x "$DENO" ] && [ -f "$CLI" ]; } || { echo "redaction-guard: tooling missing, failing open" >&2; allow; }

# Stage B — scan the egress surface.
scan_args=()
if echo "$cmd" | grep -qE 'git[[:space:]]+push'; then
  # DIFF-SCOPED: scan only the OUTGOING files, not the whole tree — so a push is
  # blocked for leaks IT introduces, never held hostage by pre-existing backlog
  # (CI does the whole-tree sweep). Resolve the repo dir from a leading `cd`.
  dir="$MIRROR"
  cdp="$(echo "$cmd" | grep -oE 'cd[[:space:]]+[^ ;&|]+' | head -1 | sed -E 's/^cd[[:space:]]+//')"
  [ -n "$cdp" ] && dir="$cdp"
  mapfile -t files < <(git -C "$dir" diff --name-only '@{u}..HEAD' 2>/dev/null || true)
  [ "${#files[@]}" -eq 0 ] && allow               # nothing outgoing (or no upstream) → allow
  for f in "${files[@]}"; do scan_args+=("$dir/$f"); done
elif echo "$cmd" | grep -qE 'swamp[[:space:]]+extension[[:space:]]+push'; then
  mf="$(echo "$cmd" | grep -oE '[^ ]*\.yaml' | head -1 || true)"
  if [ -n "$mf" ] && [ -f "$mf" ]; then scan_args=("$(dirname "$mf")"); else scan_args=(--text "$cmd"); fi
else
  # issue submit/ripple, gh pr/release: the risky content (body/title) is inline.
  scan_args=(--text "$cmd")
fi

if out="$("$DENO" run --allow-read "$CLI" --deny "$DENY" "${scan_args[@]}" 2>&1)"; then
  allow                                           # CLEAN (cli exit 0)
else
  deny "redaction gate: private identifier in the publish surface. ${out}"
fi

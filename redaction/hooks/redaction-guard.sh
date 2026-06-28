#!/usr/bin/env bash
# redaction-guard.sh — Claude Code PreToolUse guard for Bash tool calls.
#
# Two-stage classifier: (A) is this Bash command a PUBLISH/egress action? If not,
# allow instantly (no scan). (B) If yes, scan the EGRESS SURFACE (the outgoing git
# diff / the command text) with the redaction CLI and DENY on a hit.
#
# Wired via .claude/settings.json: { hooks: { PreToolUse: [ { matcher: "Bash",
# hooks: [ { type: "command", command: "<this script>" } ] } ] } }.
#
# Contract: stdin = the PreToolUse JSON; emit permissionDecision:"deny" to block,
# or nothing to allow. FAIL-OPEN on infra errors (a broken guard must never brick
# work; CI is the floor). FAIL-CLOSED only on an actual detected identifier.
#
# Config (env, portable defaults):
#   REDACTION_DENO     - deno binary (default: PATH, then ~/.deno/bin/deno)
#   REDACTION_CLI      - cli.ts path (default: resolved next to this script)
#   REDACTION_DENYLIST - private denylist file (default: none → generic tier only)

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DENO="${REDACTION_DENO:-$(command -v deno || echo "$HOME/.deno/bin/deno")}"
CLI="${REDACTION_CLI:-$HERE/../cli.ts}"
DENY="${REDACTION_DENYLIST:-}"

allow() { exit 0; }
deny() {
  jq -n --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}

input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)"
[ -z "$cmd" ] && allow

# Stage A — publish/egress action? (rsync→local-mirror is staging; `git push` gates.)
PUBLISH_RE="git[[:space:]]+push|swamp[[:space:]]+extension[[:space:]]+push|swamp[[:space:]]+issue[[:space:]]+(submit|ripple|comment)|gh[[:space:]]+(pr|release)"
echo "$cmd" | grep -qE "$PUBLISH_RE" || allow

# Infra present? else FAIL-OPEN.
{ [ -x "$DENO" ] && [ -f "$CLI" ]; } || { echo "redaction-guard: tooling missing, failing open" >&2; allow; }

deny_args=()
[ -n "$DENY" ] && [ -f "$DENY" ] && deny_args=(--deny "$DENY")

# Stage B — scan the egress surface.
scan_args=()
if echo "$cmd" | grep -qE 'git[[:space:]]+push'; then
  # DIFF-SCOPED: scan only OUTGOING files (blocks new leaks, not backlog). Resolve
  # the repo dir from a leading `cd`, else the current directory.
  dir="."
  cdp="$(echo "$cmd" | grep -oE 'cd[[:space:]]+[^ ;&|]+' | head -1 | sed -E 's/^cd[[:space:]]+//')"
  [ -n "$cdp" ] && dir="$cdp"
  mapfile -t files < <(git -C "$dir" diff --name-only '@{u}..HEAD' 2>/dev/null || true)
  [ "${#files[@]}" -eq 0 ] && allow
  for f in "${files[@]}"; do scan_args+=("$dir/$f"); done
elif echo "$cmd" | grep -qE 'swamp[[:space:]]+extension[[:space:]]+push'; then
  mf="$(echo "$cmd" | grep -oE '[^ ]*\.yaml' | head -1 || true)"
  if [ -n "$mf" ] && [ -f "$mf" ]; then scan_args=("$(dirname "$mf")"); else scan_args=(--text "$cmd"); fi
else
  scan_args=(--text "$cmd") # issue submit/ripple, gh pr/release — body is inline
fi

if out="$("$DENO" run --allow-read "$CLI" "${deny_args[@]}" "${scan_args[@]}" 2>&1)"; then
  allow
else
  deny "redaction gate: private identifier in the publish surface. ${out}"
fi

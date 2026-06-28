#!/usr/bin/env bash
# install.sh — wire the redaction gate into a repo's enforcement surfaces.
# Opt-in, idempotent, and fully visible in the resulting diff (NOT an install-time
# side effect of `swamp extension pull`). Run once per repo:
#
#   extensions/models/redaction/hooks/install.sh [target-repo-dir]
#
# Sets up, in <target> (default: cwd):
#   1. git pre-push hook  → .githooks/pre-push (+ core.hooksPath .githooks)
#   2. Claude Code guard  → .claude/settings.json PreToolUse[Bash]
#
# CI (the non-bypassable floor) is wired separately in the CI config — see README.

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-$PWD}"
cd "$TARGET"

# 1. git pre-push (tracked hooks dir, shared + version-controlled)
mkdir -p .githooks
cp "$HERE/pre-push" .githooks/pre-push
chmod +x .githooks/pre-push
git config core.hooksPath .githooks
echo "✓ git pre-push installed (core.hooksPath=.githooks)"

# 2. Claude Code PreToolUse guard (merge into .claude/settings.json)
mkdir -p .claude
SETTINGS=.claude/settings.json
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
# Path to the guard, relative to the target repo (portable across layouts).
REL="$(realpath --relative-to="$TARGET" "$HERE/redaction-guard.sh" 2>/dev/null || echo "$HERE/redaction-guard.sh")"
HOOKCMD="\"\$CLAUDE_PROJECT_DIR/$REL\""
tmp="$(mktemp)"
jq --arg cmd "$HOOKCMD" '
  .hooks.PreToolUse = ((.hooks.PreToolUse // [])
    | map(select(.matcher != "Bash"))
    + [{matcher:"Bash", hooks:[{type:"command", command:$cmd}]}])
' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
echo "✓ Claude Code PreToolUse[Bash] guard installed in $SETTINGS"

echo "Done. CI (whole-tree sweep) is the floor — wire it in your CI config (see README)."

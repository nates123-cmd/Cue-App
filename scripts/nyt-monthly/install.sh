#!/bin/bash
# Install / update the monthly NYT picks job (launchd com.nate.cue-nyt).
# The script runs from a copy in Application Support, not from any checkout,
# so a branch switch or worktree never changes what launchd executes.
# Re-run this after changing nyt-monthly.mjs.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dest="$HOME/Library/Application Support/cue-nyt"
plist="$HOME/Library/LaunchAgents/com.nate.cue-nyt.plist"

mkdir -p "$dest" "$HOME/.local/state/cue-nyt"
cp "$here/nyt-monthly.mjs" "$dest/nyt-monthly.mjs"
cp "$here/com.nate.cue-nyt.plist" "$plist"
launchctl bootout "gui/$(id -u)/com.nate.cue-nyt" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
launchctl print "gui/$(id -u)/com.nate.cue-nyt" | grep -E "state|path" | head -3
echo "installed: $dest/nyt-monthly.mjs (log ~/.local/state/cue-nyt/run.log)"

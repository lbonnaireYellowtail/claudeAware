#!/usr/bin/env bash
# Installs the Claude Code live statusline for the current user.
# Works two ways:
#   ./install.sh                              (from a cloned repo)
#   curl -fsSL <raw>/install.sh | bash        (standalone; fetches the script)
set -euo pipefail

RAW_BASE="https://raw.githubusercontent.com/lbonnaireYellowtail/claude-statusline/main"
DEST_DIR="$HOME/.claude/scripts"
DEST="$DEST_DIR/statusline.py"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"

mkdir -p "$DEST_DIR"

if [ -f "$SRC_DIR/statusline.py" ]; then
  cp "$SRC_DIR/statusline.py" "$DEST"
else
  echo "Downloading statusline.py…"
  curl -fsSL "$RAW_BASE/statusline.py" -o "$DEST"
fi
chmod +x "$DEST"

echo "✅ Installed: $DEST"
echo
echo "Now add this block to the top level of ~/.claude/settings.json:"
echo
cat <<'EOF'
  "statusLine": {
    "type": "command",
    "command": "$HOME/.claude/scripts/statusline.py",
    "padding": 0,
    "refreshInterval": 2
  }
EOF
echo
echo "Then start a new Claude Code session (or reload) to see it."

#!/usr/bin/env bash
# Candidate: CURRENT install.sh source-selection logic (pre CS-006/CS-007).
# Reference only — mirrors install.sh:11-21 with injectable RAW_BASE/DEST_DIR so
# the harness can drive it in a sandbox. Do not ship this; it is the "before".
set -euo pipefail

RAW_BASE="${RAW_BASE:?}"
DEST_DIR="${DEST_DIR:?}"
DEST="$DEST_DIR/statusline.py"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"

mkdir -p "$DEST_DIR"

if [ -f "$SRC_DIR/statusline.py" ]; then
  cp "$SRC_DIR/statusline.py" "$DEST"
else
  curl -fsSL "$RAW_BASE/statusline.py" -o "$DEST"
fi
chmod +x "$DEST"

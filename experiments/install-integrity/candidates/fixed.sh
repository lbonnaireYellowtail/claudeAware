#!/usr/bin/env bash
# Candidate: PROPOSED install.sh logic (CS-006 source guard + CS-007 verify).
# Reference behaviour the real install.sh should match once implemented.
#   CS-006: only trust a local copy when the script genuinely runs from a file on
#           disk (BASH_SOURCE points at a real path). Pipe mode -> download; cwd is
#           never used as a source.
#   CS-007: verify the downloaded statusline.py against a pinned SHA-256 before
#           chmod. No sha tool -> fail closed (don't silently skip). Local copies
#           are not hashed (no release pin exists during development).
set -euo pipefail

RAW_BASE="${RAW_BASE:?}"
DEST_DIR="${DEST_DIR:?}"
DEST="$DEST_DIR/statusline.py"
# Injected at release time by the digest-automation step (see ADR-0002 / CS-007).
EXPECTED_SHA256="${EXPECTED_SHA256:?}"

mkdir -p "$DEST_DIR"

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else echo "__no_sha_tool__"; fi
}

# CS-006: a real on-disk script path is the only signal for "running from a
# checkout". In `curl | bash` mode BASH_SOURCE[0] is unset, so this stays empty and
# we fall through to the verified download instead of reading the cwd.
SRC_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [ -n "$SRC_DIR" ] && [ -f "$SRC_DIR/statusline.py" ]; then
  cp "$SRC_DIR/statusline.py" "$DEST"
else
  tmp="$(mktemp)"
  curl -fsSL "$RAW_BASE/statusline.py" -o "$tmp"
  got="$(sha256_of "$tmp")"
  if [ "$got" = "__no_sha_tool__" ]; then
    echo "ERROR: no SHA-256 tool (shasum/sha256sum) available; cannot verify download" >&2
    rm -f "$tmp"; exit 3
  fi
  if [ "$got" != "$EXPECTED_SHA256" ]; then
    echo "ERROR: statusline.py checksum mismatch (expected $EXPECTED_SHA256, got $got)" >&2
    rm -f "$tmp"; exit 4
  fi
  mv "$tmp" "$DEST"
fi
chmod +x "$DEST"

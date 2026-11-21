#!/usr/bin/env bash
# Start the local keymap editor (editor/server.mjs) and open it in the browser.
#   ./scripts/keymap-editor.sh              # http://localhost:8737/
#   ./scripts/keymap-editor.sh --no-open    # just serve
#   ./scripts/keymap-editor.sh --port 9000
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v node >/dev/null || { echo "node not found - install Node.js 18+" >&2; exit 1; }

args=() open=--open
for a in "$@"; do
  if [ "$a" = --no-open ]; then open=""; else args+=("$a"); fi
done
exec node "$REPO/editor/server.mjs" ${open:+"$open"} ${args[@]+"${args[@]}"}

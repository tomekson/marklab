#!/usr/bin/env bash
# Spustí lokální bridge, který servíruje dashboard (docs/) i /api na jedné origin.
#   scripts/run-local.sh          # http://127.0.0.1:8777/
#   scripts/run-local.sh 8080
set -euo pipefail
cd "$(dirname "$0")/.."
ulimit -n 4096 2>/dev/null || true
PY=.venv/bin/python; [ -x "$PY" ] || PY=python3
exec "$PY" tools/twl/bridge.py "${1:-8777}"

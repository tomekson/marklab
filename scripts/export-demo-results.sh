#!/usr/bin/env bash
# Spustí všechny pipeline nad sample-data/*.txt a uloží reporty do output/ (plné, s raw)
# a docs/demo/ (zeštíhlené pro GitHub Pages).
#   scripts/export-demo-results.sh                 # včetně statistických pipeline
#   scripts/export-demo-results.sh --no-statistical
set -euo pipefail
cd "$(dirname "$0")/.."
PY=.venv/bin/python; [ -x "$PY" ] || PY=python3
exec "$PY" tools/twl/cli.py export-demo "$@"

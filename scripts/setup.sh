#!/usr/bin/env bash
# Příprava prostředí: naklonuje upstream nástroje do vendor/, založí venv (uv, Python 3.12)
# a nainstaluje dewatermark. watermarks-remover je stdlib-only, nic neinstaluje.
# Volby:
#   --with-synthid   samostatný venv .venv-synthid s torch/transformers pro reverse-SynthID-text (GB stahování)
#   --sync-js        přepíše docs/vendor/dewatermark-unicode z vendor/dewatermark/web
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)

WITH_SYNTHID=0; SYNC_JS=0
for a in "$@"; do case "$a" in --with-synthid) WITH_SYNTHID=1;; --sync-js) SYNC_JS=1;; esac; done

command -v uv >/dev/null || { echo "Chybí uv (https://docs.astral.sh/uv/). Nainstaluj: curl -LsSf https://astral.sh/uv/install.sh | sh"; exit 1; }

mkdir -p vendor
clone() { [ -d "vendor/$2/.git" ] && echo "vendor/$2 už existuje" || git clone --depth 1 "$1" "vendor/$2"; }
clone https://github.com/cyzanfar/text-watermark-remover.git dewatermark
clone https://github.com/guillaumemeyer/watermarks-remover.git watermarks-remover
clone https://github.com/aloshdenny/reverse-SynthID-text.git reverse-SynthID-text

[ -d .venv ] || uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -e vendor/dewatermark
.venv/bin/dewatermark --version

if [ "$SYNC_JS" = 1 ]; then
  cp vendor/dewatermark/web/{sanitizer.mjs,unicode-policy.mjs,sanitizer.d.ts,LICENSE} docs/vendor/dewatermark-unicode/
  echo "docs/vendor/dewatermark-unicode synchronizováno"
fi

if [ "$WITH_SYNTHID" = 1 ]; then
  echo "reverse-SynthID-text: samostatný venv (torch/transformers; upstream piny jsou pro CUDA, instaluji CPU/MPS varianty)"
  [ -d .venv-synthid ] || uv venv --python 3.11 .venv-synthid
  uv pip install --python .venv-synthid/bin/python "torch>=2.4" "transformers>=4.43" "numpy<2" scikit-learn tqdm matplotlib immutabledict
  echo "Paraphrase vyžaduje gated model google/gemma-2b-it: huggingface-cli login a souhlas s licencí."
fi

echo
echo "Hotovo. Spusť: scripts/run-local.sh"
echo "Stav nástrojů: .venv/bin/python tools/twl/cli.py capabilities"

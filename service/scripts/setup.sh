#!/usr/bin/env bash
# One-time setup of the Dalbit local service (Linux / macOS).
#   bash scripts/setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PY=${PYTHON:-python3}
"$PY" -c 'import sys; assert sys.version_info >= (3, 10), "Python 3.10+ required"'
command -v node >/dev/null || { echo "Node.js 18+ is required (https://nodejs.org)"; exit 1; }

[ -d .venv ] || "$PY" -m venv .venv
.venv/bin/python -m pip install --upgrade pip
if [ "$(uname)" = "Linux" ]; then
  # CPU-only PyTorch (~200 MB) instead of the default CUDA build (~3-5 GB).
  .venv/bin/pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu \
    || { echo "CPU wheel index unreachable; falling back to PyPI torch (large download)"; .venv/bin/pip install torch torchvision; }
else
  .venv/bin/pip install torch torchvision   # macOS wheels are CPU/MPS already
fi
.venv/bin/pip install -r requirements.txt
(cd bergamot_host && npm ci --no-audit --no-fund)
.venv/bin/python scripts/download_models.py "$@"
.venv/bin/python tests/fixtures/generate.py >/dev/null 2>&1 || echo "(test fixtures need tests/fonts; see README to run tests)"
.venv/bin/python -m dalbit doctor --warm
echo
echo "Done. Start the service with:  .venv/bin/python -m dalbit serve"
echo "Pairing token for the extension: $(.venv/bin/python -m dalbit token)"

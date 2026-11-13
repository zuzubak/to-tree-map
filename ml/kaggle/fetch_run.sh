#!/bin/bash
# Download the latest Kaggle run's outputs into data/<name>/ and build its HTML report.
#   ./kaggle/fetch_run.sh run3
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=data/${1:?usage: fetch_run.sh <name>}
mkdir -p "$OUT"
.venv/bin/kaggle kernels output zuzubak/toronto-tree-species-train -p "$OUT"
.venv/bin/python -I report.py "$OUT"

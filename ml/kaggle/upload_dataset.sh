#!/bin/bash
# Package the crops + manifest as a private Kaggle dataset (create once, then version).
set -euo pipefail
cd "$(dirname "$0")/.."
DS=data/kaggle_ds
rm -rf "$DS" && mkdir -p "$DS"
cp data/manifest.csv data/genus_classes.csv data/species_classes.csv "$DS"/
.venv/bin/python -I kaggle/pack_crops.py data/crops "$DS"   # one big file: Kaggle's mount is slow per-file
cat > "$DS/dataset-metadata.json" <<JSON
{"title": "toronto-tree-crops-2025", "id": "zuzubak/toronto-tree-crops-2025",
 "licenses": [{"name": "other"}],
 "description": "192px crops of City of Toronto 2025 orthophoto (Open Government Licence - Toronto) centred on street trees."}
JSON
if .venv/bin/kaggle datasets status zuzubak/toronto-tree-crops-2025 >/dev/null 2>&1; then
  .venv/bin/kaggle datasets version -p "$DS" -m "rebuild" -r skip
else
  .venv/bin/kaggle datasets create -p "$DS" -r skip
fi

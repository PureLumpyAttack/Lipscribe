#!/usr/bin/env bash
# Download model weights and GRID test data with resume + size checks.
# Run from ml/:  bash scripts/download.sh [models|grid|all]
set -euo pipefail
cd "$(dirname "$0")/.."

fetch() {  # url dest expected_bytes
  local url=$1 dest=$2 want=$3
  mkdir -p "$(dirname "$dest")"
  for attempt in $(seq 1 50); do
    local have=0
    [[ -f $dest ]] && have=$(stat -f %z "$dest" 2>/dev/null || stat -c %s "$dest")
    if [[ $have -eq $want ]]; then echo "ok   $dest"; return 0; fi
    if [[ $have -gt $want ]]; then rm -f "$dest"; fi
    echo "get  $dest ($have/$want bytes, attempt $attempt)"
    curl -sSL --fail --connect-timeout 20 --speed-limit 1000 --speed-time 60 -C - -o "$dest" "$url" || sleep 3
  done
  echo "FAILED $dest" >&2; return 1
}

HF=https://huggingface.co/Amanvir
ZEN="https://zenodo.org/records/3625687/files"
what=${1:-all}

if [[ $what == models || $what == all ]]; then
  fetch "$HF/LRS3_V_WER19.1/resolve/main/model.json" models/LRS3_V_WER19.1/model.json 5512
  fetch "$HF/LRS3_V_WER19.1/resolve/main/model.pth" models/LRS3_V_WER19.1/model.pth 1001908942
  [[ -s models/lm_en_subword/model.json ]] || curl -sSLf -o models/lm_en_subword/model.json "$HF/lm_en_subword/resolve/main/model.json"
  fetch "$HF/lm_en_subword/resolve/main/model.pth" models/lm_en_subword/model.pth 215076928
fi

if [[ $what == grid || $what == all ]]; then
  fetch "$ZEN/alignments.zip?download=1" data/grid/_zips/alignments.zip 20091485
  fetch "$ZEN/s1.zip?download=1" data/grid/_zips/s1.zip 423520514
  fetch "$ZEN/s4.zip?download=1" data/grid/_zips/s4.zip 491885378
fi

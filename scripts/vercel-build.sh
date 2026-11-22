#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

rm -rf public
mkdir -p public api/models

# Static app: GitHub Pages and Vercel serve the same files.
cp index.html public/
cp -r css js assets docs public/

# Quantized Whisper base model used by the Vercel function.
MODEL="api/models/ggml-base-q5_1.bin"
if [ ! -s "$MODEL" ]; then
  echo "Downloading $MODEL ..."
  curl -L --fail --retry 3 --retry-delay 2 \
    -o "$MODEL" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin"
fi
test -s "$MODEL"
ls -lh "$MODEL"

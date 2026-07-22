#!/usr/bin/env bash
# Sets up local speech-to-text: whisper.cpp binary + base English model (~142MB).
# TTS needs no setup — it uses macOS's built-in `say`.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v whisper-cli >/dev/null 2>&1; then
  echo "Installing whisper-cpp via Homebrew..."
  brew install whisper-cpp
else
  echo "whisper-cli already installed: $(command -v whisper-cli)"
fi

mkdir -p models
MODEL=models/ggml-base.en.bin
if [ ! -f "$MODEL" ]; then
  echo "Downloading whisper base.en model (~142MB)..."
  curl -L --progress-bar -o "$MODEL" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"
else
  echo "Model already present: $MODEL"
fi

echo ""
echo "Voice is ready. Launch the app and click the microphone button."
echo "(Override with WHISPER_BIN / WHISPER_MODEL in .env if you use a different setup.)"

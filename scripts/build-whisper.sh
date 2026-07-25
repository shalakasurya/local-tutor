#!/usr/bin/env bash
# Builds a self-contained static whisper-cli for bundling into the packaged app
# (the brew binary is dynamically linked against Homebrew dylibs and can't be
# shipped). Cached in vendor/ — delete vendor/whisper-cli to force a rebuild.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f vendor/whisper-cli ]; then
  echo "vendor/whisper-cli already built"
  exit 0
fi

command -v cmake >/dev/null || { echo "cmake required: brew install cmake"; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
echo "Cloning whisper.cpp..."
git clone --depth 1 https://github.com/ggerganov/whisper.cpp "$WORK/whisper.cpp" -q

echo "Building static whisper-cli (this takes a couple of minutes)..."
cmake -S "$WORK/whisper.cpp" -B "$WORK/build" \
  -DBUILD_SHARED_LIBS=OFF \
  -DWHISPER_BUILD_TESTS=OFF \
  -DCMAKE_BUILD_TYPE=Release > /dev/null
cmake --build "$WORK/build" -j --target whisper-cli > /dev/null

mkdir -p vendor
cp "$WORK/build/bin/whisper-cli" vendor/whisper-cli
chmod +x vendor/whisper-cli

echo "Verifying the binary is self-contained (no Homebrew dylibs):"
if otool -L vendor/whisper-cli | grep -E "/opt/homebrew|/usr/local"; then
  echo "ERROR: binary links against non-system libraries" >&2
  exit 1
fi
echo "OK: vendor/whisper-cli ($(du -h vendor/whisper-cli | cut -f1))"

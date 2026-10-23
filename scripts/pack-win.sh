#!/bin/sh
# Builds a Windows folder that runs with no install: Node.js (win-x64) + compiled app + launchers.
# Needs internet to fetch Node.js. Output: dist-win/Asisten-Dokumen-Pilot-<version>-Win64.zip
set -eu
cd "$(dirname "$0")/.."
NODE_VERSION="${NODE_VERSION:-22.22.1}"
VERSION=$(node -p "require('./package.json').version")
OUT=dist-win
STAGE="$OUT/Asisten-Dokumen-Pilot"
CACHE="$OUT/cache"

rm -rf "$STAGE" && mkdir -p "$STAGE/node" "$CACHE"

# 1. Node.js for Windows, verified against the checksum list published by nodejs.org
ZIP="node-v$NODE_VERSION-win-x64.zip"
[ -f "$CACHE/$ZIP" ] || curl -fsSL -o "$CACHE/$ZIP" "https://nodejs.org/dist/v$NODE_VERSION/$ZIP"
curl -fsSL -o "$CACHE/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
(cd "$CACHE" && grep " $ZIP\$" SHASUMS256.txt | sha256sum -c -)
unzip -q -j "$CACHE/$ZIP" "node-v$NODE_VERSION-win-x64/node.exe" -d "$STAGE/node"

# 2. App: compiled code, production dependencies only (pure JavaScript, nothing native)
npm run build
cp -r dist public "$STAGE/"
mkdir -p "$STAGE/docs" && cp -r docs/sample "$STAGE/docs/sample"
cp package.json package-lock.json "$STAGE/"
(cd "$STAGE" && npm ci --omit=dev --omit=optional --no-audit --no-fund --ignore-scripts && rm -f package-lock.json)

# 3. Launchers and instructions (Windows line endings so Notepad and cmd are happy)
for f in start.bat ingest.bat tanya.bat config.env BACA-SAYA.txt; do sed 's/$/\r/' "windows/$f" > "$STAGE/$f"; done
cp LICENSE "$STAGE/LICENSE.txt"

( cd "$OUT" && rm -f "Asisten-Dokumen-Pilot-$VERSION-Win64.zip" && python3 -m zipfile -c "Asisten-Dokumen-Pilot-$VERSION-Win64.zip" Asisten-Dokumen-Pilot )
( cd "$OUT" && sha256sum "Asisten-Dokumen-Pilot-$VERSION-Win64.zip" )

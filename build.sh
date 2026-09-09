#!/usr/bin/env bash
# Package & install RGBTv on an LG webOS TV using the webOS CLI (ares-*).
# Install CLI:  npm install -g @webos-tools/cli
set -e
cd "$(dirname "$0")"
mkdir -p dist
echo "▶ Packaging…"
command -v ares-package >/dev/null 2>&1 || { echo "ares-package is missing. Install @webos-tools/cli first." >&2; exit 127; }
ares-package app services/com.rgbtv.app.service -o dist
IPK=$(ls -t dist/*.ipk | head -1)
echo "✔ Built: $IPK"
if [ -n "$1" ]; then
  echo "▶ Installing on device '$1'…"
  ares-install -d "$1" "$IPK"
  ares-launch  -d "$1" com.rgbtv.app
fi

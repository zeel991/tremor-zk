#!/usr/bin/env bash
# Renders og.html to public/og.png (1200x630) with a headless Chromium.
# Set CHROME to any Chromium/Chrome binary; defaults to Playwright's headless shell.
set -euo pipefail
cd "$(dirname "$0")"
CHROME="${CHROME:-$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell 2>/dev/null | tail -1)}"
"$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1200,630 --virtual-time-budget=3000 \
  --screenshot="$PWD/../public/og.png" "file://$PWD/og.html"
echo "wrote public/og.png"

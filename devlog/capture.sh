#!/usr/bin/env bash
# Capture footage for the Creator Track video and log it.
#   capture.sh shot <beat> <slug> "note"          full-screen screenshot
#   capture.sh clip <beat> <slug> <secs> "note"   screen recording (needs Screen Recording permission)
#   capture.sh note <beat> "note"                 log entry only
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$DIR/footage"
ts=$(date +%Y%m%d-%H%M%S)
log() { printf -- "- %s · beat %s · %s%s\n" "$(date -u +%Y-%m-%dT%H:%MZ)" "$1" "$2" "${3:+ → \`$3\`}" >> "$DIR/LOG.md"; }

case "${1:-}" in
  shot) f="footage/$ts-b$2-$3.png"; screencapture -x "$DIR/$f"; log "$2" "${4:-}" "$f" ;;
  clip) f="footage/$ts-b$2-$3.mov"; screencapture -x -v -V "$4" "$DIR/$f"; log "$2" "${5:-}" "$f" ;;
  note) log "$2" "$3" ;;
  *) sed -n '2,5p' "$0"; exit 1 ;;
esac

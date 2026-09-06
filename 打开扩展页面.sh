#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if command -v brave-browser >/dev/null 2>&1; then
  brave-browser "brave://extensions/" >/dev/null 2>&1 &
elif command -v brave >/dev/null 2>&1; then
  brave "brave://extensions/" >/dev/null 2>&1 &
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "brave://extensions/" >/dev/null 2>&1 &
else
  printf '%s\n' '请在 Brave 地址栏打开 brave://extensions/'
fi
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$SCRIPT_DIR" >/dev/null 2>&1 &
fi

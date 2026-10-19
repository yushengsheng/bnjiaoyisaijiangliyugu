#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/双击打开.app"
BINARY="$(mktemp "$APP/Contents/MacOS/.EventLens.XXXXXX")"
trap 'rm -f "$BINARY"' EXIT

/usr/bin/clang -Os -fobjc-arc -mmacosx-version-min=11.0 \
  -arch arm64 -arch x86_64 -framework Cocoa \
  "$ROOT/scripts/macos-launcher.m" -o "$BINARY"
chmod 755 "$BINARY"
mv "$BINARY" "$APP/Contents/MacOS/EventLens"
/usr/bin/codesign --force --sign - --timestamp=none "$APP"

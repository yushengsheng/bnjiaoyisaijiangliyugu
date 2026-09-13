#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VERSION=$(node -p "require('$ROOT/package.json').version")
NAME="EventLens-Local-v$VERSION"
DIST="$ROOT/dist"
STAGE="$DIST/$NAME"
ARCHIVE="$DIST/$NAME.zip"

rm -rf "$STAGE" "$ARCHIVE"
rm -f "$DIST"/EventLens-Local-v*.zip
mkdir -p "$STAGE/lib" "$STAGE/public" "$STAGE/data"

for file in server.js package.json README.md PRIVACY.md CHANGELOG.md LICENSE start.sh start.bat Open-EventLens.command 双击打开.command; do
  cp "$ROOT/$file" "$STAGE/$file"
done
cp "$ROOT"/lib/*.js "$STAGE/lib/"
cp "$ROOT"/public/* "$STAGE/public/"
cp "$ROOT"/data/seed-campaigns.json "$ROOT"/data/seed-snapshots.json "$STAGE/data/"

cat >"$STAGE/INSTALL.txt" <<EOF
EventLens Local v$VERSION

Requirements:
- Node.js 22 or newer
- Brave Browser or Google Chrome (required for leaderboard updates)

macOS:
1. Double-click Open-EventLens.command
2. If macOS blocks it, right-click and choose Open

Windows:
1. Double-click start.bat

Manual:
1. Run: node server.js
2. Open: http://127.0.0.1:3000

The service only listens on 127.0.0.1 and is not exposed to the LAN or internet.
EOF

(
  cd "$DIST"
  zip -qr "$ARCHIVE" "$NAME"
)
rm -rf "$STAGE"
printf '%s\n' "$ARCHIVE"

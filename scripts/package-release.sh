#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VERSION=$(cd "$ROOT" && node -p 'require("./package.json").version')
NAME="EventLens-Local-v$VERSION"
DIST="$ROOT/dist"
STAGE="$DIST/$NAME"
ARCHIVE="$DIST/$NAME.zip"

rm -rf "$STAGE" "$ARCHIVE"
mkdir -p "$STAGE/lib" "$STAGE/public" "$STAGE/data" "$STAGE/scripts"
cp "$ROOT/scripts/launch-desktop.js" "$STAGE/scripts/"
cp "$ROOT/scripts/macos-launcher.m" "$ROOT/scripts/build-macos-launcher.sh" "$STAGE/scripts/"
cp -R "$ROOT/双击打开.app" "$STAGE/双击打开.app"

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
1. Double-click 双击打开.app (no Terminal window)
2. If macOS blocks it, right-click and choose Open
3. Allow access if macOS asks about Downloads, Desktop, Documents or the project volume
4. If access was denied, select the current project folder in the launcher's permission dialog
5. Closing the last EventLens page stops the service after about 10 seconds

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
# macOS 自带 zip 不标记 UTF-8 文件名；同步本地头与目录头，避免中文入口在其他解压器中乱码。
node - "$ARCHIVE" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const buffer = fs.readFileSync(file);
const end = buffer.lastIndexOf(Buffer.from("504b0506", "hex"));
if (end < 0) throw new Error("发布 ZIP 缺少目录尾部");
const count = buffer.readUInt16LE(end + 10);
let offset = buffer.readUInt32LE(end + 16);
for (let index = 0; index < count; index++) {
  if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("发布 ZIP 目录头无效");
  const nameLength = buffer.readUInt16LE(offset + 28);
  new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(offset + 46, offset + 46 + nameLength));
  const local = buffer.readUInt32LE(offset + 42);
  if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error("发布 ZIP 本地头无效");
  buffer.writeUInt16LE(buffer.readUInt16LE(offset + 8) | 0x800, offset + 8);
  buffer.writeUInt16LE(buffer.readUInt16LE(local + 6) | 0x800, local + 6);
  offset += 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
}
fs.writeFileSync(file, buffer);
NODE
rm -rf "$STAGE"
printf '%s\n' "$ARCHIVE"

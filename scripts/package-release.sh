#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VERSION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$ROOT/manifest.json")
NAME="Trading-Volume-bn-v$VERSION"
DIST="$ROOT/dist"
STAGE="$DIST/$NAME"
ARCHIVE="$DIST/$NAME.zip"

rm -rf "$STAGE" "$ARCHIVE"
mkdir -p "$STAGE/icons"

for file in manifest.json background.js bridge.js core.js dashboard.html dashboard.css dashboard.js page-hook.js README.md PRIVACY.md CHANGELOG.md; do
  cp "$ROOT/$file" "$STAGE/$file"
done
cp "$ROOT"/icons/*.png "$STAGE/icons/"

cat >"$STAGE/INSTALL.txt" <<EOF
交易量排行榜统计器 v$VERSION

1. 打开 Brave，在地址栏输入 brave://extensions/
2. 打开右上角“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择当前文件夹（包含 manifest.json 的文件夹）
5. 点击扩展图标开始使用

注意：GitHub Release ZIP 需要先解压。Brave 不允许直接从 GitHub 安装 ZIP/CRX；
如需商店式一键安装和自动更新，需要另行发布到 Chrome Web Store。
EOF

(
  cd "$DIST"
  zip -qr "$ARCHIVE" "$NAME"
)
rm -rf "$STAGE"
printf '%s\n' "$ARCHIVE"

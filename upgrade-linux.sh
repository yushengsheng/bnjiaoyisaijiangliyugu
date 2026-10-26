#!/usr/bin/env bash
set +x
set -euo pipefail

# 固定到此正式版，避免清单与下载文件跨版本混用。
VERSION=2.2.3
BASE="https://github.com/yushengsheng/bnjiaoyisaijiangliyugu/releases/download/v$VERSION"
ARCHIVE="EventLens-Linux-v$VERSION.run"
[[ $# -eq 0 ]] || { printf '%s\n' '无需输入端口或账号，升级会保留原配置。' >&2; exit 1; }
for command in curl sha256sum mktemp; do
  command -v "$command" >/dev/null || { printf '%s\n' '缺少下载或校验工具，请在服务器本机检查依赖。' >&2; exit 1; }
done
TEMP=$(mktemp -d)
trap 'rm -rf -- "$TEMP"' EXIT
curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 2 --connect-timeout 20 --max-time 600 "$BASE/SHA256SUMS" -o "$TEMP/SHA256SUMS"
curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 2 --connect-timeout 20 --max-time 600 "$BASE/$ARCHIVE" -o "$TEMP/$ARCHIVE"
EXPECTED=$(awk -v file="$ARCHIVE" '$2 == file { print $1 }' "$TEMP/SHA256SUMS")
[[ "$EXPECTED" =~ ^[a-fA-F0-9]{64}$ ]] || { printf '%s\n' '升级校验清单无效，未执行安装包。' >&2; exit 1; }
ACTUAL=$(sha256sum "$TEMP/$ARCHIVE")
[[ "${ACTUAL%% *}" == "$EXPECTED" ]] || { printf '%s\n' '升级包校验失败，未执行安装包。' >&2; exit 1; }
if [[ $EUID -eq 0 ]]; then
  bash "$TEMP/$ARCHIVE" --upgrade
else
  sudo bash "$TEMP/$ARCHIVE" --upgrade
fi

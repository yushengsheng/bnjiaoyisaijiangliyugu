#!/usr/bin/env bash
set -euo pipefail

PACKAGE_ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd)
VERSION=$(node -p "require(process.argv[1]).version" "$PACKAGE_ROOT/package.json")
PACKAGE_TEMP=$(mktemp -d "${TMPDIR:-/tmp}/eventlens-linux-package.XXXXXX")
trap 'rm -rf -- "$PACKAGE_TEMP"' EXIT
mkdir -p "$PACKAGE_ROOT/dist" "$PACKAGE_TEMP/source/lib" "$PACKAGE_TEMP/source/public" "$PACKAGE_TEMP/source/data"
for file in server.js package.json install-linux.sh LINUX-安装教程.md README.md PRIVACY.md LICENSE; do
  cp "$PACKAGE_ROOT/$file" "$PACKAGE_TEMP/source/"
done
cp "$PACKAGE_ROOT"/lib/*.js "$PACKAGE_TEMP/source/lib/"
cp "$PACKAGE_ROOT"/public/* "$PACKAGE_TEMP/source/public/"
cp "$PACKAGE_ROOT/data/seed-campaigns.json" "$PACKAGE_ROOT/data/seed-snapshots.json" "$PACKAGE_TEMP/source/data/"
chmod 755 "$PACKAGE_TEMP/source/install-linux.sh"
COPYFILE_DISABLE=1 tar -czf "$PACKAGE_TEMP/source.tar.gz" -C "$PACKAGE_TEMP/source" .
if command -v sha256sum >/dev/null; then
  PAYLOAD_HASH=$(sha256sum "$PACKAGE_TEMP/source.tar.gz" | cut -d' ' -f1)
else
  PAYLOAD_HASH=$(shasum -a 256 "$PACKAGE_TEMP/source.tar.gz" | cut -d' ' -f1)
fi
OUTPUT="$PACKAGE_ROOT/dist/EventLens-Linux-v$VERSION.run"
{
  printf '#!/usr/bin/env bash\nset +x\nset -euo pipefail\nEXPECTED_HASH=%s\n' "$PAYLOAD_HASH"
  cat <<'BOOTSTRAP'
PACKAGE_TEMP=$(mktemp -d "${TMPDIR:-/tmp}/eventlens-unpack.XXXXXX")
trap 'rm -rf -- "$PACKAGE_TEMP"' EXIT
PAYLOAD_LINE=$(awk '/^__EVENTLENS_ARCHIVE_BELOW__$/ { print NR + 1; exit }' "$0")
tail -n +"$PAYLOAD_LINE" "$0" >"$PACKAGE_TEMP/source.tar.gz"
if command -v sha256sum >/dev/null; then
  ACTUAL_HASH=$(sha256sum "$PACKAGE_TEMP/source.tar.gz" | cut -d' ' -f1)
else
  ACTUAL_HASH=$(shasum -a 256 "$PACKAGE_TEMP/source.tar.gz" | cut -d' ' -f1)
fi
if [[ "$ACTUAL_HASH" != "$EXPECTED_HASH" ]]; then
  printf '%s\n' '安装包校验失败，请重新下载并上传。' >&2
  exit 1
fi
mkdir "$PACKAGE_TEMP/source"
tar -xzf "$PACKAGE_TEMP/source.tar.gz" -C "$PACKAGE_TEMP/source"
bash "$PACKAGE_TEMP/source/install-linux.sh" "$@"
exit $?
__EVENTLENS_ARCHIVE_BELOW__
BOOTSTRAP
  cat "$PACKAGE_TEMP/source.tar.gz"
} >"$OUTPUT"
chmod 755 "$OUTPUT"
printf '%s\n' "$OUTPUT"

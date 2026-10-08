#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
PORT="${PORT:-3000}"
URL="http://127.0.0.1:${PORT}"

find_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return; fi
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /opt/homebrew/opt/node@22/bin/node /usr/local/opt/node@22/bin/node "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.local/share/pi-node/*/bin/node; do
    if [ -x "$candidate" ]; then printf '%s\n' "$candidate"; return; fi
  done
}

NODE_BIN="$(find_node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "未检测到 Node.js。请安装 Node.js 22 或更高版本：https://nodejs.org/"
  if [ "${1:-}" = "--desktop" ]; then exit 1; fi
  read -r -p "按回车键退出..." _
  exit 1
fi

NODE_MAJOR="$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "当前 Node.js 版本过低：$("$NODE_BIN" --version)"
  echo "请升级到 Node.js 22 或更高版本。"
  if [ "${1:-}" = "--desktop" ]; then exit 1; fi
  read -r -p "按回车键退出..." _
  exit 1
fi

if [ "${1:-}" = "--desktop" ]; then
  exec "$NODE_BIN" "$ROOT/scripts/launch-desktop.js"
fi

if command -v curl >/dev/null 2>&1 && curl -fsS "$URL/api/health" 2>/dev/null | grep -q 'eventlens-local'; then
  echo "EventLens 已在运行，正在打开浏览器..."
  open "$URL" 2>/dev/null || xdg-open "$URL" 2>/dev/null || true
  exit 0
fi

if command -v lsof >/dev/null 2>&1 && lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 $PORT 已被其他程序占用，请关闭该程序或使用其他 PORT。"
  read -r -p "按回车键退出..." _
  exit 1
fi

printf '%s\n' "======================================================" " EventLens 本地交易赛分析工具" " 地址：$URL" " Node：$("$NODE_BIN" --version)" " 关闭此窗口或按 Ctrl+C 可停止服务" "======================================================"
(sleep 1.2; open "$URL" 2>/dev/null || xdg-open "$URL" 2>/dev/null || true) &
exec "$NODE_BIN" server.js

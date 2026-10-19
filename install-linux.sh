#!/usr/bin/env bash
set +x
set -euo pipefail

EVENTLENS_SOURCE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
APP_ROOT=/opt/eventlens
DATA_DIR=/var/lib/eventlens
CONFIG_DIR=/etc/eventlens
UNIT_FILE=/etc/systemd/system/eventlens.service
SERVICE_USER=eventlens
INSTALL_TEMP=
INSTALL_COMPLETE=0
OWN_SERVICE=0

say() { printf '%s\n' "$*"; }
fail() { printf '安装失败：%s\n' "$*" >&2; return 1; }

usage() {
  cat <<'HELP'
在已登录的 Linux 服务器上运行：
  sudo bash install-linux.sh 服务器IPv4 网页端口 网页用户名 [网页密码]

也支持同样参数的 EventLens-Linux-v*.run 单文件安装包。
省略密码时会隐藏输入，并要求再输入一次确认。
用户名和密码用于访问网页，与服务器登录账号无关。
--check 仅检查参数，不安装；--help 显示说明。

支持：Ubuntu 22.04+、Debian 12+、Rocky/AlmaLinux/RHEL 9+、Fedora 40+。
要求：x86_64（amd64）架构、systemd、root 或 sudo 权限、可下载运行环境的网络。
HELP
}

validate_options() {
  local part
  local -a octets
  [[ "$WEB_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { fail 'IP 请填写服务器的 IPv4 地址。'; return 1; }
  IFS=. read -r -a octets <<< "$WEB_IP"
  for part in "${octets[@]}"; do
    [[ ${#part} -le 3 ]] && (( 10#$part <= 255 )) || { fail 'IPv4 地址格式不正确。'; return 1; }
  done
  [[ "$WEB_PORT" =~ ^[0-9]{1,5}$ ]] && (( 10#$WEB_PORT >= 1 && 10#$WEB_PORT <= 65535 )) || { fail '网页端口必须在 1 至 65535 之间。'; return 1; }
  WEB_PORT=$((10#$WEB_PORT))
  [[ "$WEB_USERNAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,63}$ ]] || { fail '网页用户名需为 1 至 64 位英文字母、数字或 _.@-，并以字母或数字开头。'; return 1; }
  [[ "$WEB_PASSWORD" != *$'\n'* && "$WEB_PASSWORD" != *$'\r'* ]] || { fail '密码不能包含换行。'; return 1; }
}

read_password() {
  local repeated
  if [[ -z "$WEB_PASSWORD" ]]; then
    [[ -r /dev/tty ]] || { fail '当前终端无法输入密码，请在服务器交互终端运行。'; return 1; }
    IFS= read -r -s -p '请设置网页密码（输入时不显示）：' WEB_PASSWORD </dev/tty
    printf '\n' >/dev/tty
    IFS= read -r -s -p '请再输入一次确认：' repeated </dev/tty
    printf '\n' >/dev/tty
    [[ "$WEB_PASSWORD" == "$repeated" ]] || { fail '两次密码不同，请重新运行安装命令。'; return 1; }
  fi
  [[ -n "$WEB_PASSWORD" ]] || { fail '网页密码不能为空。'; return 1; }
  validate_options
}

detect_platform() {
  [[ $(uname -s) == Linux ]] || { fail '请在 Linux 服务器内运行此安装包。'; return 1; }
  [[ $(uname -m) == x86_64 ]] || { fail '本安装包目前支持 x86_64（amd64）服务器。'; return 1; }
  [[ -f /etc/os-release ]] || { fail '无法识别 Linux 系统。'; return 1; }
  local ID= VERSION_ID= ID_LIKE=
  # 系统自带的发行版信息，不加载用户配置。
  . /etc/os-release
  local major=${VERSION_ID%%.*}
  case "$ID" in
    ubuntu) [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 22 )) || { fail 'Ubuntu 需为 22.04 或更高版本。'; return 1; }; PACKAGE_MANAGER=apt ;;
    debian) [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 12 )) || { fail 'Debian 需为 12 或更高版本。'; return 1; }; PACKAGE_MANAGER=apt ;;
    rocky|almalinux|rhel|centos) [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 9 )) || { fail '此发行版需为 9 或更高版本。'; return 1; }; PACKAGE_MANAGER=dnf ;;
    fedora) [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 40 )) || { fail 'Fedora 需为 40 或更高版本。'; return 1; }; PACKAGE_MANAGER=dnf ;;
    *) fail '暂不支持此发行版；建议使用 Ubuntu 24.04 x86_64。'; return 1 ;;
  esac
  command -v systemctl >/dev/null && [[ -d /run/systemd/system ]] || { fail '此安装包需要使用 systemd 的常规服务器，不适用于未启用 systemd 的容器。'; return 1; }
}

preflight() {
  [[ $EUID -eq 0 ]] || { fail '请在命令前加 sudo，或使用 root 登录服务器。'; return 1; }
  [[ -f "$EVENTLENS_SOURCE/server.js" && -f "$EVENTLENS_SOURCE/package.json" && -d "$EVENTLENS_SOURCE/lib" && -d "$EVENTLENS_SOURCE/public" ]] || { fail '安装包不完整，请重新上传完整单文件安装包。'; return 1; }
  check_existing_install
}

check_existing_install() {
  [[ ! -e "$APP_ROOT/.eventlens-installed" ]] || { fail '已经安装，脚本不会覆盖已有程序和数据。修改配置或重启请参照教程。'; return 1; }
  if [[ -e "$UNIT_FILE" ]] && ! head -n 1 "$UNIT_FILE" | grep -qx '# Managed by EventLens Linux installer'; then
    fail '同名服务已存在，且不是本脚本创建，已停止安装以保留原服务。'; return 1
  fi
  if [[ ! -f "$APP_ROOT/.eventlens-installing" ]]; then
    local folder
    for folder in "$APP_ROOT" "$DATA_DIR" "$CONFIG_DIR"; do
      [[ ! -e "$folder" || ( -d "$folder" && -z $(ls -A "$folder") ) ]] || { fail '安装目录已有文件，已停止安装，不会覆盖原数据。'; return 1; }
    done
    if getent passwd "$SERVICE_USER" >/dev/null || getent group "$SERVICE_USER" >/dev/null; then
      fail '同名系统账号已存在，已停止安装，不会修改原账号。'; return 1
    fi
  else
    if getent passwd "$SERVICE_USER" >/dev/null; then
      local existing_uid existing_home
      existing_uid=$(id -u "$SERVICE_USER")
      existing_home=$(getent passwd "$SERVICE_USER" | cut -d: -f6)
      [[ "$existing_uid" != 0 && "$existing_home" == "$DATA_DIR" ]] || { fail '系统账号与本安装记录不符。'; return 1; }
    fi
  fi
}

cleanup() {
  local status=$?
  trap - EXIT
  if (( status != 0 && OWN_SERVICE == 1 && INSTALL_COMPLETE == 0 )); then
    systemctl disable --now eventlens.service >/dev/null 2>&1 || true
  fi
  unset WEB_PASSWORD
  [[ -z "$INSTALL_TEMP" ]] || rm -rf -- "$INSTALL_TEMP"
  exit "$status"
}

download() {
  curl --fail --location --silent --show-error --retry 2 --connect-timeout 20 --max-time 600 "$1" -o "$2"
}

install_dependencies() {
  say '1/6 安装基础依赖…'
  if [[ "$PACKAGE_MANAGER" == apt ]]; then
    apt-get update >"$INSTALL_TEMP/packages.log" 2>&1 || { fail '更新软件源失败，请检查服务器网络后重试。'; return 1; }
    DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl tar xz-utils iproute2 util-linux >>"$INSTALL_TEMP/packages.log" 2>&1 || { fail '基础依赖安装失败，请检查软件源和系统版本。'; return 1; }
  else
    dnf install -y ca-certificates curl tar xz iproute util-linux >"$INSTALL_TEMP/packages.log" 2>&1 || { fail '基础依赖安装失败，请检查软件源和系统版本。'; return 1; }
  fi
}

check_port() {
  local listeners
  listeners=$(ss -H -ltnp "sport = :$WEB_PORT")
  if [[ -n "$listeners" ]]; then
    local pid=
    if [[ -f "$APP_ROOT/.eventlens-installing" && -f "$UNIT_FILE" ]]; then
      pid=$(systemctl show -p MainPID --value eventlens.service 2>/dev/null || true)
    fi
    [[ -n "$pid" && "$pid" != 0 && "$listeners" == *"pid=$pid,"* ]] || { fail '网页端口已被其他程序占用，请换一个端口。'; return 1; }
  fi
}

install_node() {
  say '2/6 安装独立 Node.js 22 运行环境…'
  NODE_BIN="$APP_ROOT/runtime/node/bin/node"
  if [[ -x "$NODE_BIN" ]] && "$NODE_BIN" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; then return; fi
  download 'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt' "$INSTALL_TEMP/SHASUMS256.txt" || { fail 'Node.js 校验清单下载失败。'; return 1; }
  local checksum archive
  read -r checksum archive < <(awk '$2 ~ /^node-v22\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$/ { print $1, $2; exit }' "$INSTALL_TEMP/SHASUMS256.txt") || { fail '无法识别 Node.js 下载版本。'; return 1; }
  [[ "$checksum" =~ ^[a-fA-F0-9]{64}$ && "$archive" =~ ^node-v22\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$ ]] || { fail 'Node.js 校验清单格式无效。'; return 1; }
  download "https://nodejs.org/dist/latest-v22.x/$archive" "$INSTALL_TEMP/node.tar.xz" || { fail 'Node.js 下载失败。'; return 1; }
  printf '%s  %s\n' "$checksum" "$INSTALL_TEMP/node.tar.xz" | sha256sum -c - >"$INSTALL_TEMP/checksum.log" 2>&1 || { fail 'Node.js 校验失败，请重新运行，程序不会使用未通过校验的文件。'; return 1; }
  install -d -o root -g root -m 755 "$APP_ROOT/runtime" "$APP_ROOT/runtime/node"
  tar -xJf "$INSTALL_TEMP/node.tar.xz" -C "$APP_ROOT/runtime/node" --strip-components=1
  "$NODE_BIN" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || { fail 'Node.js 不能在此系统运行。'; return 1; }
}

install_browser() {
  say '3/6 准备无界面浏览器…'
  local browser
  for browser in /usr/bin/brave-browser /usr/bin/brave /usr/bin/google-chrome; do
    [[ ! -x "$browser" ]] || return 0
  done
  if [[ "$PACKAGE_MANAGER" == apt ]]; then
    download 'https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb' "$INSTALL_TEMP/chrome.deb" || { fail 'Chrome 下载失败，请检查服务器能否访问 Google 下载地址。'; return 1; }
    # apt 的下载沙箱用户需要能够读取本地安装包；目录不包含网页凭据。
    chmod 755 "$INSTALL_TEMP"
    chmod 644 "$INSTALL_TEMP/chrome.deb"
    DEBIAN_FRONTEND=noninteractive apt-get install -y "$INSTALL_TEMP/chrome.deb" >>"$INSTALL_TEMP/packages.log" 2>&1 || { fail 'Chrome 安装失败，请检查系统版本和软件源。'; return 1; }
    chmod 700 "$INSTALL_TEMP"
  else
    download 'https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm' "$INSTALL_TEMP/chrome.rpm" || { fail 'Chrome 下载失败。'; return 1; }
    dnf install -y "$INSTALL_TEMP/chrome.rpm" >>"$INSTALL_TEMP/packages.log" 2>&1 || { fail 'Chrome 安装失败，请检查软件源。'; return 1; }
  fi
  [[ -x /usr/bin/google-chrome ]] || { fail '未找到安装后的 Chrome。'; return 1; }
}

install_application() {
  say '4/6 安装程序和独立运行账号…'
  if ! getent passwd "$SERVICE_USER" >/dev/null; then
    useradd --system --user-group --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 750 "$DATA_DIR"
  install -d -o root -g root -m 755 "$APP_ROOT/app" "$APP_ROOT/app/lib" "$APP_ROOT/app/public" "$APP_ROOT/app/data"
  if [[ -f "$UNIT_FILE" ]]; then systemctl stop eventlens.service; fi
  install -m 644 "$EVENTLENS_SOURCE/server.js" "$EVENTLENS_SOURCE/package.json" "$APP_ROOT/app/"
  install -m 644 "$EVENTLENS_SOURCE"/lib/*.js "$APP_ROOT/app/lib/"
  install -m 644 "$EVENTLENS_SOURCE"/public/* "$APP_ROOT/app/public/"
  install -m 644 "$EVENTLENS_SOURCE/data/seed-campaigns.json" "$EVENTLENS_SOURCE/data/seed-snapshots.json" "$APP_ROOT/app/data/"
  "$NODE_BIN" --check "$APP_ROOT/app/server.js"
}

quote_value() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//\$/\\\$}
  value=${value//\`/\\\`}
  printf '"%s"' "$value"
}

write_configuration() {
  say '5/6 保存网页账号并配置开机启动…'
  local bind_capability=
  if (( WEB_PORT < 1024 )); then bind_capability=AmbientCapabilities=CAP_NET_BIND_SERVICE; fi
  install -d -o root -g root -m 700 "$CONFIG_DIR"
  {
    printf 'PORT=%s\nNODE_ENV=production\n' "$WEB_PORT"
    printf 'EVENTLENS_DATA_DIR=%s\n' "$(quote_value "$DATA_DIR")"
    printf 'EVENTLENS_ACCESS_USERNAME=%s\n' "$(quote_value "$WEB_USERNAME")"
    printf 'EVENTLENS_ACCESS_PASSWORD=%s\n' "$(quote_value "$WEB_PASSWORD")"
  } >"$CONFIG_DIR/eventlens.env"
  chmod 600 "$CONFIG_DIR/eventlens.env"
  # systemd 环境文件不做变量展开；引号和反斜线按其双引号规则转义。
  cat >"$UNIT_FILE" <<UNIT
# Managed by EventLens Linux installer
[Unit]
Description=EventLens trading competition dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
$bind_capability
WorkingDirectory=$APP_ROOT/app
EnvironmentFile=$CONFIG_DIR/eventlens.env
ExecStart=$NODE_BIN $APP_ROOT/app/server.js --server
Restart=on-failure
RestartSec=5
KillMode=control-group
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
UNIT
  chmod 644 "$UNIT_FILE"
  OWN_SERVICE=1
  systemctl daemon-reload
  systemctl enable --now eventlens.service
}

check_health() {
  say '6/6 检查网页服务…'
  local attempt status
  for (( attempt=0; attempt<30; attempt++ )); do
    # 认证信息通过标准输入传给 curl，不放入子进程的命令参数。
    status=$({
      printf 'url = "http://127.0.0.1:%s/api/health"\n' "$WEB_PORT"
      printf 'user = %s\n' "$(quote_value "$WEB_USERNAME:$WEB_PASSWORD")"
    } | curl --config - --silent --max-time 2 --output "$INSTALL_TEMP/health.json" --write-out '%{http_code}' 2>/dev/null) || true
    if [[ "$status" == 200 ]] && "$NODE_BIN" -e 'const fs=require("fs"); try { const d=JSON.parse(fs.readFileSync(process.argv[1])); process.exit(d.ok === true && d.app === "eventlens-local" && d.desktop === false ? 0 : 1); } catch { process.exit(1); }' "$INSTALL_TEMP/health.json"; then return; fi
    sleep 1
  done
  fail '服务健康检查未通过。已停止本次创建的服务；修复网络或依赖后可重新运行安装命令。'
}

main() {
  local check_only=0
  if [[ ${1:-} == --help || ${1:-} == -h ]]; then usage; return; fi
  if [[ ${1:-} == --check ]]; then check_only=1; shift; fi
  if (( $# < 3 || $# > 4 )); then usage; return 1; fi
  WEB_IP=$1 WEB_PORT=$2 WEB_USERNAME=$3 WEB_PASSWORD=${4:-}
  validate_options
  if (( check_only )); then say '参数检查通过；未下载、未安装、未启动任何服务。'; return; fi
  detect_platform
  preflight
  read_password
  umask 077
  INSTALL_TEMP=$(mktemp -d /tmp/eventlens-install.XXXXXX)
  trap cleanup EXIT
  install_dependencies
  exec 9>/run/lock/eventlens-install.lock
  flock -n 9 || { fail '另一个安装任务正在运行，请等待它完成。'; return 1; }
  preflight
  check_port
  install -d -o root -g root -m 755 "$APP_ROOT"
  touch "$APP_ROOT/.eventlens-installing"
  install_node
  install_browser
  install_application
  write_configuration
  check_health
  touch "$APP_ROOT/.eventlens-installed"
  INSTALL_COMPLETE=1
  say '安装成功。网页已启用账号密码保护，并设置为开机启动。'
  say "访问地址：http://$WEB_IP:$WEB_PORT"
  say '用你刚才设置的网页账号密码登录；关闭终端不会停止服务。'
  say "还需在云服务器安全组和服务器防火墙中放行 TCP $WEB_PORT。脚本不会关闭或修改已有防火墙。"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi

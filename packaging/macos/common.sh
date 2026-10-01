# shellcheck shell=bash
set -euo pipefail

GATEWAY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$GATEWAY_ROOT/node/bin/node"
APP_ENTRY="$GATEWAY_ROOT/app/dist/index.js"
OPENCODE_BIN="$GATEWAY_ROOT/app/node_modules/opencode-ai/bin/opencode.exe"
DATA_DIR="$HOME/Library/Application Support/TomsGateway"
ENV_FILE="${GATEWAY_ENV_FILE:-$DATA_DIR/gateway.env}"
LOG_DIR="$DATA_DIR/logs"
LOG_FILE="$LOG_DIR/gateway.log"
ERR_FILE="$LOG_DIR/gateway.err.log"
LABEL="com.toms.gateway"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SERVICE_PATH="$GATEWAY_ROOT/app/node_modules/.bin:$GATEWAY_ROOT/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

gateway_setting() {
  local name="$1" fallback="$2" value=""
  value="${!name:-}"
  if [[ -z "$value" && -f "$ENV_FILE" ]]; then
    value="$(grep -E "^[[:space:]]*${name}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")"
  fi
  echo "${value:-$fallback}"
}

gateway_port() { gateway_setting PORT 3701; }
opencode_port() { gateway_setting OPENCODE_PORT 3702; }
opencode_enabled() { [[ "$(gateway_setting OPENCODE_ENABLE false)" == "true" ]]; }

port_in_use() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

assert_ports_free() {
  local port
  port="$(gateway_port)"
  if port_in_use "$port"; then
    echo "端口 $port 已被占用。先运行 status.sh 查看，或运行 stop.sh 停掉旧进程。" >&2
    exit 1
  fi
  if opencode_enabled; then
    port="$(opencode_port)"
    if port_in_use "$port"; then
      echo "OpenCode 端口 $port 已被占用。先运行 status.sh 查看，或运行 stop.sh 停掉旧进程。" >&2
      exit 1
    fi
  fi
}

gateway_healthy() { curl -fsS --max-time 3 "http://127.0.0.1:$(gateway_port)/healthz" >/dev/null 2>&1; }

refuse_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    echo "请不要用 sudo 运行。服务要注册在当前登录用户下，直接执行 ./macos/install-service.sh。" >&2
    exit 1
  fi
}

# gui 域只在桌面登录会话里存在。SSH 和 sudo 下会得到 125：Domain does not support specified action。
gui_session_available() { launchctl print "gui/$(id -u)" >/dev/null 2>&1; }

service_target() { printf 'gui/%s' "$(id -u)"; }

service_loaded() { launchctl print "$(service_target)/$LABEL" >/dev/null 2>&1; }

require_gui_session() {
  refuse_root
  if gui_session_available; then
    return 0
  fi
  local session
  session="$(launchctl managername 2>/dev/null || true)"
  echo "当前没有图形登录会话，launchctl 无法注册服务（125：Domain does not support specified action）。" >&2
  if [[ -n "$session" ]]; then
    echo "当前会话类型：${session}。" >&2
  fi
  echo "请用要运行 Gateway 的用户登录这台 Mac 的桌面，打开「终端」后再执行，不要加 sudo，也不要从 SSH 里执行。" >&2
  exit 1
}

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

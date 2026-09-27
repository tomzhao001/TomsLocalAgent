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

service_loaded() { launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; }

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

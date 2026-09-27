#!/usr/bin/env bash
# 在前台运行 Gateway，用于调试。Ctrl+C 退出。
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "找不到 $ENV_FILE 。先运行 install-service.sh 生成配置，或设置 GATEWAY_ENV_FILE。" >&2
  exit 1
fi
assert_ports_free
export GATEWAY_ENV_FILE="$ENV_FILE"
export PATH="$SERVICE_PATH:$PATH"
cd "$GATEWAY_ROOT"
exec "$NODE_BIN" --disable-warning=ExperimentalWarning "$APP_ENTRY"

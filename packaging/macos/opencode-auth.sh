#!/usr/bin/env bash
# 用包内的 OpenCode 登录模型服务商，凭据保存在当前用户的 OpenCode 数据目录。
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

export PATH="$SERVICE_PATH:$PATH"
exec "$OPENCODE_BIN" auth login

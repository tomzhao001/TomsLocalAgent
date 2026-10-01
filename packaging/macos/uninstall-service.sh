#!/usr/bin/env bash
# 停止并删除后台服务。配置、数据库和日志保留在用户数据目录。
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require_gui_session

"$GATEWAY_ROOT/macos/stop.sh" --quiet
if [[ -f "$PLIST" ]]; then
  rm -f "$PLIST"
  echo "已删除后台服务 $LABEL。"
else
  echo "后台服务 $LABEL 没有注册。"
fi
echo "数据保留在：$DATA_DIR"

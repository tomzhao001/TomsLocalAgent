#!/usr/bin/env bash
# 停止后台服务。服务仍然注册着，下次登录会自动启动；立即重新启动请运行 install-service.sh。
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require_gui_session

if service_loaded; then
  launchctl bootout "$(service_target)/$LABEL" || true
  [[ "${1:-}" == "--quiet" ]] || echo "已停止 Gateway。"
else
  [[ "${1:-}" == "--quiet" ]] || echo "Gateway 没有在运行。"
fi

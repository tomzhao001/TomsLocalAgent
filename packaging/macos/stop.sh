#!/usr/bin/env bash
# 停止后台服务。服务仍然注册着，下次登录会自动启动；立即重新启动请运行 install-service.sh。
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require_gui_session

was_loaded=0
if service_loaded; then
  was_loaded=1
fi
bootout_service
if [[ "$was_loaded" -eq 1 ]]; then
  for _ in $(seq 1 10); do
    if service_loaded; then
      sleep 0.3
    else
      break
    fi
  done
fi
if service_loaded; then
  echo "没能停掉 Gateway。请在桌面终端执行：launchctl bootout \"$(service_target)/$LABEL\"" >&2
  exit 1
fi
if [[ "${1:-}" == "--quiet" ]]; then
  exit 0
fi
if [[ "$was_loaded" -eq 1 ]]; then
  echo "已停止 Gateway。"
else
  echo "Gateway 没有在运行。"
fi

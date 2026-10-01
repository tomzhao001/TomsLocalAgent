#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
refuse_root

if [[ -f "$PLIST" ]]; then echo "后台服务：已注册"; else echo "后台服务：未注册"; fi

if ! gui_session_available; then
  echo "进程：当前会话看不到图形登录里的服务。请到这台 Mac 的桌面「终端」里查看，不要从 SSH 查看。"
elif service_loaded; then
  pid="$(launchctl print "$(service_target)/$LABEL" | awk '/^[[:space:]]*pid =/ { print $3; exit }')"
  echo "进程：运行中（${pid:-未知}）"
else
  echo "进程：未运行"
fi

port="$(gateway_port)"
if gateway_healthy; then echo "健康检查：正常 http://127.0.0.1:$port"; else echo "健康检查：无响应（端口 $port）"; fi

echo "配置文件：$ENV_FILE"
echo "日志：$LOG_FILE"

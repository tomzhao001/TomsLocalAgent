#!/usr/bin/env bash
# 注册登录后自动启动的 LaunchAgent，并立即启动。重复运行等于重启。
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require_gui_session

xattr -dr com.apple.quarantine "$GATEWAY_ROOT" 2>/dev/null || true
mkdir -p "$DATA_DIR" "$LOG_DIR" "$(dirname "$PLIST")"

if [[ ! -f "$ENV_FILE" ]]; then
  if [[ ! -f "$GATEWAY_ROOT/gateway.env" ]]; then
    echo "找不到配置文件：$GATEWAY_ROOT/gateway.env" >&2
    exit 1
  fi
  cp "$GATEWAY_ROOT/gateway.env" "$ENV_FILE"
  echo "已复制配置文件：${ENV_FILE}"
fi

password="$(gateway_setting ADMIN_PASSWORD "")"
if [[ -z "$password" || "$password" == "change-me" ]]; then
  echo "请先在 $ENV_FILE 中把 ADMIN_PASSWORD 改成你自己的密码。"
  exit 1
fi

"$GATEWAY_ROOT/macos/stop.sh" --quiet
sleep 1
assert_ports_free

cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$NODE_BIN")</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>$(xml_escape "$APP_ENTRY")</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$GATEWAY_ROOT")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml_escape "$SERVICE_PATH")</string>
    <key>GATEWAY_ENV_FILE</key>
    <string>$(xml_escape "$ENV_FILE")</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$LOG_FILE")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$ERR_FILE")</string>
</dict>
</plist>
EOF

load_service

port="$(gateway_port)"
for _ in $(seq 1 30); do
  if gateway_healthy; then
    echo "Gateway 已启动：http://127.0.0.1:${port}"
    echo "手机访问：在本机执行 tailscale serve --bg ${port}，然后打开 tailscale 给出的 https 地址。"
    exit 0
  fi
  sleep 1
done
echo "服务已注册，但 30 秒内没有通过健康检查。运行 logs.sh --errors 查看原因。"
exit 1

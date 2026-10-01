#!/usr/bin/env bash
# 查看日志。--errors 查看错误输出，--follow 持续跟踪。
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

file="$LOG_FILE"
follow=""
for arg in "$@"; do
  case "$arg" in
    --errors) file="$ERR_FILE" ;;
    --follow) follow="-f" ;;
  esac
done

if [[ ! -f "$file" ]]; then
  echo "还没有日志：$file"
  exit 0
fi
tail -n 100 $follow "$file"

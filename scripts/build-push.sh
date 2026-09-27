#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$SCRIPT_DIR/deploy.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "缺少 $ENV_FILE ，请先复制 scripts/deploy.env.example" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${ACR_REGISTRY:?请在 deploy.env 中设置 ACR_REGISTRY}"
: "${ACR_USERNAME:?请在 deploy.env 中设置 ACR_USERNAME}"
: "${ACR_PASSWORD:?请在 deploy.env 中设置 ACR_PASSWORD}"
: "${ACR_IMAGE:?请在 deploy.env 中设置 ACR_IMAGE}"

TAG="${ACR_TAG:-latest}"
if [[ -n "${ACR_NAMESPACE:-}" ]]; then
  IMAGE="${ACR_REGISTRY}/${ACR_NAMESPACE}/${ACR_IMAGE}:${TAG}"
else
  IMAGE="${ACR_REGISTRY}/${ACR_IMAGE}:${TAG}"
fi

echo "登录 ${ACR_REGISTRY}"
printf '%s' "$ACR_PASSWORD" | docker login "$ACR_REGISTRY" --username "$ACR_USERNAME" --password-stdin

echo "构建 ${IMAGE}"
docker build -f "$ROOT/docker/Dockerfile" -t "$IMAGE" "$ROOT"

echo "推送 ${IMAGE}"
docker push "$IMAGE"
echo "已推送 ${IMAGE}"

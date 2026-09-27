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

CONTAINER_NAME="${CONTAINER_NAME:-toms-gateway}"
HTTP_PORT="${HTTP_PORT:-3000}"
DATA_DIR_HOST="${DATA_HOST_DIR:-$ROOT/data}"
WORKSPACE_DIR_HOST="${WORKSPACE_HOST_ROOT:-$ROOT/workspaces}"
APP_ENV="$ROOT/.env"

mkdir -p "$DATA_DIR_HOST" "$WORKSPACE_DIR_HOST"

echo "登录 ${ACR_REGISTRY}"
printf '%s' "$ACR_PASSWORD" | docker login "$ACR_REGISTRY" --username "$ACR_USERNAME" --password-stdin

echo "拉取 ${IMAGE}"
docker pull "$IMAGE"

if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  docker rm -f "$CONTAINER_NAME"
fi

RUN_ARGS=(
  -d
  --name "$CONTAINER_NAME"
  --restart unless-stopped
  -p "127.0.0.1:${HTTP_PORT}:3000"
  -e DATA_DIR=/data
  -e WORKSPACE_ROOTS=/workspaces
  -v "${DATA_DIR_HOST}:/data"
  -v "${WORKSPACE_DIR_HOST}:/workspaces"
)
if [[ -f "$APP_ENV" ]]; then
  RUN_ARGS+=(--env-file "$APP_ENV")
fi

docker run "${RUN_ARGS[@]}" "$IMAGE"
echo "已启动 ${CONTAINER_NAME} ，本机端口 ${HTTP_PORT}"

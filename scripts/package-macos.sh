#!/usr/bin/env bash
# 在 macOS 上打包 TomsGateway，输出 dist/TomsGateway-<版本>-darwin-<arch>/。
# 加上 --tar 才额外生成同名 tar.gz。--skip-install 跳过 pnpm install。
# 加上 --start 会在打包完成后运行输出目录里的 install-service.sh。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SKIP_INSTALL=0
MAKE_TAR=0
START=0
for arg in "$@"; do
  case "$arg" in
    --skip-install) SKIP_INSTALL=1 ;;
    --tar) MAKE_TAR=1 ;;
    --start) START=1 ;;
    *) echo "未知参数：${arg}" >&2; exit 1 ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "请在 macOS 上运行本脚本。" >&2
  exit 1
fi

case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) echo "不支持的架构：$(uname -m)" >&2; exit 1 ;;
esac

NODE_VERSION="$(tr -d '[:space:]' < scripts/node-version.txt)"
VERSION="$(node -p "require('./apps/server/package.json').version")"
NAME="TomsGateway-$VERSION-darwin-$ARCH"
STAGE="$ROOT/dist/$NAME"
CACHE="$ROOT/dist/cache"
mkdir -p "$CACHE"

if [[ "$SKIP_INSTALL" -eq 0 ]]; then
  echo "==> 安装依赖"
  pnpm install --frozen-lockfile
fi
echo "==> 构建 shared、server、web"
pnpm --filter @gateway/shared build
pnpm --filter @gateway/server build
pnpm --filter @gateway/web build

if [[ "$START" -eq 1 ]]; then
  PLIST="$HOME/Library/LaunchAgents/com.toms.gateway.plist"
  if [[ -f "$PLIST" ]]; then
    WD="$(/usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$PLIST" 2>/dev/null || true)"
    WD="${WD%/}"
    STAGE_CMP="${STAGE%/}"
    if [[ -n "$WD" && -d "$WD" && -d "$STAGE_CMP" ]]; then
      WD="$(cd "$WD" && pwd)"
      STAGE_CMP="$(cd "$STAGE_CMP" && pwd)"
    fi
    if [[ -n "$WD" && "$WD" == "$STAGE_CMP" ]]; then
      echo "==> 停止占用输出目录的服务"
      "$ROOT/packaging/macos/stop.sh"
    fi
  fi
fi

rm -rf "$STAGE"
echo "==> 生成生产依赖"
pnpm --filter @gateway/server deploy --prod --config.node-linker=hoisted "dist/$NAME/app"
find "$STAGE/app/node_modules" -maxdepth 1 -type d -name 'opencode-*' ! -name 'opencode-ai' -exec rm -rf {} +
if [[ ! -x "$STAGE/app/node_modules/opencode-ai/bin/opencode.exe" ]]; then
  echo "没有找到 OpenCode 可执行文件" >&2
  exit 1
fi
cp -R "$ROOT/apps/web/dist" "$STAGE/app/public"

echo "==> 准备 Node $NODE_VERSION"
TARBALL="node-v$NODE_VERSION-darwin-$ARCH.tar.gz"
BASE="https://nodejs.org/dist/v$NODE_VERSION"
SUMS="$CACHE/SHASUMS256-$NODE_VERSION.txt"
[[ -f "$SUMS" ]] || curl -fsSL "$BASE/SHASUMS256.txt" -o "$SUMS"
[[ -f "$CACHE/$TARBALL" ]] || curl -fsSL "$BASE/$TARBALL" -o "$CACHE/$TARBALL"
EXPECTED="$(grep " $TARBALL\$" "$SUMS" | awk '{ print $1 }')"
ACTUAL="$(shasum -a 256 "$CACHE/$TARBALL" | awk '{ print $1 }')"
if [[ -z "$EXPECTED" || "$EXPECTED" != "$ACTUAL" ]]; then
  rm -f "$CACHE/$TARBALL"
  echo "Node 压缩包校验失败，已删除缓存，请重试" >&2
  exit 1
fi
mkdir -p "$STAGE/node"
tar -xzf "$CACHE/$TARBALL" -C "$STAGE/node" --strip-components 1

echo "==> 复制启动脚本"
cp -R "$ROOT/packaging/macos" "$STAGE/macos"
ENV_SOURCE="$HOME/Library/Application Support/TomsGateway/gateway.env"
if [[ ! -f "$ENV_SOURCE" ]]; then
  echo "找不到配置文件：${ENV_SOURCE}" >&2
  echo "请先在本机准备好 gateway.env，再重新打包。" >&2
  exit 1
fi
cp "$ENV_SOURCE" "$STAGE/gateway.env"
chmod +x "$STAGE"/macos/*.sh

echo "已生成：${STAGE}"
if [[ "$MAKE_TAR" -eq 1 ]]; then
  echo "==> 压缩"
  rm -f "$ROOT/dist/$NAME.tar.gz"
  tar -czf "$ROOT/dist/$NAME.tar.gz" -C "$ROOT/dist" "$NAME"
  echo "已生成：$ROOT/dist/$NAME.tar.gz"
fi
if [[ "$START" -eq 1 ]]; then
  echo "==> 安装并启动服务"
  "$STAGE/macos/install-service.sh"
fi

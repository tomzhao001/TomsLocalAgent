#!/usr/bin/env bash
# 在 macOS 上打包 TomsGateway，输出 dist/TomsGateway-<版本>-darwin-<arch>.tar.gz。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

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

if [[ "${1:-}" != "--skip-install" ]]; then
  echo "==> 安装依赖"
  pnpm install --frozen-lockfile
fi
echo "==> 构建 shared、server、web"
pnpm --filter @gateway/shared build
pnpm --filter @gateway/server build
pnpm --filter @gateway/web build

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
cp "$ROOT/packaging/gateway.env.example" "$STAGE/gateway.env.example"
chmod +x "$STAGE"/macos/*.sh

echo "==> 压缩"
rm -f "$ROOT/dist/$NAME.tar.gz"
tar -czf "$ROOT/dist/$NAME.tar.gz" -C "$ROOT/dist" "$NAME"
echo "已生成：$ROOT/dist/$NAME.tar.gz"

# TomsLocalAgent

本地单用户 AI Gateway。手机或电脑通过网页登录后，可以在指定的 workspace 里使用 Cursor 或 OpenCode。

## 本地调试

需要 Node.js 22.13 或更高版本，以及 pnpm 9。在仓库根目录执行：

```powershell
pnpm install
Copy-Item .env.example .env
New-Item -ItemType Directory -Force -Path data, workspaces | Out-Null
```

后端不会自动读取 `.env`。本地用浏览器访问时，在启动后端的终端里设置下面这些变量。`COOKIE_SECURE` 必须是 `false`，否则 HTTP 下登录 Cookie 不会被浏览器保存。`WORKSPACE_ROOTS` 换成你本机允许创建 workspace 的目录。

```powershell
$env:ADMIN_PASSWORD = "dev-password"
$env:COOKIE_SECURE = "false"
$env:DATA_DIR = "data"
$env:WORKSPACE_ROOTS = "E:\NewBee\workspace\TomsLocalAgent\workspaces"
$env:PORT = "3000"
pnpm --filter @gateway/server dev
```

另开一个终端启动前端。Vite 会把 `/api` 和 `/healthz` 代理到 `http://127.0.0.1:3000`。

```powershell
pnpm --filter @gateway/web dev
```

浏览器打开 `http://127.0.0.1:5173`，用 `ADMIN_PASSWORD` 登录。

可选变量：

- `CURSOR_API_KEY`：设置后 Cursor 模式会连接真的 Cursor SDK
- `OPENCODE_ENABLE=true`：启动本机的 OpenCode 服务
- `AGENT_RUNTIME=fake`：不调用真模型，方便看聊天和锁

## 打包并部署到 ACR

把 `scripts/deploy.env.example` 复制为 `scripts/deploy.env`，填入仓库地址、命名空间、镜像名、标签、用户名和密码。`scripts/deploy.env` 不会进入 git。

在开发机打包并推送：

```powershell
.\scripts\build-push.ps1
```

```bash
./scripts/build-push.sh
```

在 Linux 服务器上拉取并启动（只需要 shell）：

```bash
./scripts/deploy.sh
```

服务监听 `127.0.0.1` 上 `deploy.env` 里的 `HTTP_PORT`（默认 3000）。应用配置仍然来自仓库根目录的 `.env`。

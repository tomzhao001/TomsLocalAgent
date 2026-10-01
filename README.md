# TomsLocalAgent

本地单用户 AI Gateway。手机或电脑通过网页登录后，可以在指定的 workspace 里使用 Cursor 或 OpenCode。

Gateway 直接跑在你的 Windows 或 macOS 上，以当前登录用户的身份运行，所以 Cursor 的 local agent 能直接读写本机仓库，并沿用你的 git 凭据、SSH key 和 PATH。

## 本地调试

需要 Node.js 22.13 或更高版本，以及 pnpm 9。在仓库根目录执行：

```powershell
pnpm install
Copy-Item .env.example .env
```

编辑 `.env`：

- `ADMIN_PASSWORD` 改成你的密码
- `WORKSPACE_ROOTS` 填本机允许创建 workspace 的目录
- `COOKIE_SECURE` 改为 `false`，本地用 http 访问时登录 Cookie 才能保存

启动后端，用 `GATEWAY_ENV_FILE` 指向这份配置：

```powershell
$env:GATEWAY_ENV_FILE = (Resolve-Path .env).Path
pnpm --filter @gateway/server dev
```

另开一个终端启动前端。Vite 会把 `/api` 和 `/healthz` 代理到 `http://127.0.0.1:3701`。

```powershell
pnpm --filter @gateway/web dev
```

浏览器打开 `http://127.0.0.1:5173`，用 `ADMIN_PASSWORD` 登录。

`.env` 里还有几个可选项：

- `CURSOR_API_KEY`：设置后 Cursor 模式会连接真的 Cursor SDK
- `OPENCODE_ENABLE=true`：启动 OpenCode 服务，端口是 `OPENCODE_PORT`（默认 3702）
- `AGENT_RUNTIME=fake`：不调用真模型，方便看聊天、锁和工作流
- `WORKFLOW_MODEL`：开发、DevOps 和拆卡使用的 Cursor 模型，默认 `auto`
- `REVIEW_MODEL`：Review 使用的模型。留空则与 `WORKFLOW_MODEL` 相同
- `DISPATCH_INTERVAL_MS`：工作流调度的轮询间隔，默认 60000（每分钟一次）

## 聊天和工作流

- 顶部下拉框切换 Workspace，每个 Workspace 下有「聊天」和「工作流」两个子页。Workspace 在设置页添加。
- **聊天只读**：Cursor 聊天用 plan 模式加只读工具白名单，OpenCode 在服务端禁止编辑和 shell。聊天前后会对比各仓库的 `git status`，有改动时在消息旁标红。
- **拆卡**：在聊天里点「转为工作流」，或在工作流页点「拆卡」。拆卡由一个单独的只读 agent 完成，结果写入数据库成为草稿，确认后追加到队尾。
- **工作流**：每个 Workspace 有一条需求卡队列，严格串行执行。开发循环先用 plan 写出包含 TDD 的计划，再按计划开发，然后 Review 和 DevOps。手动新增可以改选 QA 工作流，那张卡只跑端到端测试。Plan 和开发复用同一个 Cursor agent；Review 每次单独开一个短对话，只看本次 diff 和验收标准。只有工作流能修改代码。
- **调度**：后台每分钟轮询一次，推进到下一步。卡住时（打回超限、推送失败、agent 提问）在对应节点下方输入，下一次轮询时继续。
- 聊天和工作流使用两把独立的锁，工作流运行期间可以照常聊天。

## 打包

安装包自带固定版本的 Node（见 `scripts/node-version.txt`）和 OpenCode，目标机器不用另外安装。`argon2`、Cursor SDK 和 OpenCode 都带有平台相关的二进制，所以必须在目标系统上打包。

Windows（在 Windows 上运行）：

```powershell
.\scripts\package-windows.ps1
```

输出 `dist\TomsGateway-<版本>-win-x64.zip`。

macOS（在 Mac 上运行，架构按 `uname -m` 自动选择 arm64 或 x64）：

```bash
./scripts/package-macos.sh
```

输出 `dist/TomsGateway-<版本>-darwin-<arch>.tar.gz`。

两个脚本都可以加 `-SkipInstall` / `--skip-install` 跳过 `pnpm install`。

## 安装与运行

把安装包解压到一个固定目录，例如 `D:\Apps\TomsGateway` 或 `~/Apps/TomsGateway`。配置和数据不在安装目录里：

| 系统 | 配置文件 | 数据库和日志 |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\TomsGateway\gateway.env` | `%LOCALAPPDATA%\TomsGateway` |
| macOS | `~/Library/Application Support/TomsGateway/gateway.env` | `~/Library/Application Support/TomsGateway` |

### Windows

```powershell
cd D:\Apps\TomsGateway
powershell -ExecutionPolicy Bypass -File .\windows\install-service.ps1
```

第一次运行会生成 `gateway.env` 然后退出。改好 `ADMIN_PASSWORD` 和 `WORKSPACE_ROOTS` 之后再运行一次，就会在「任务计划程序」里注册 `TomsGateway`，登录后自动启动，进程意外退出时 10 秒后自动拉起。

`windows\` 下的其他脚本：

- `status.ps1`：查看服务、进程和健康检查
- `stop.ps1`：停止服务，下次登录仍会自动启动
- `logs.ps1`：查看日志，`-Errors` 看错误输出，`-Follow` 持续跟踪
- `start.ps1`：在前台运行，用于调试
- `opencode-auth.ps1`：登录 OpenCode 要用的模型服务商
- `uninstall-service.ps1`：删除服务，配置和数据保留

### macOS

```bash
cd ~/Apps/TomsGateway
./macos/install-service.sh
```

同样是第一次生成 `gateway.env` 后退出，改好后再运行一次。脚本会先去掉 Gatekeeper 的隔离标记，然后注册 `~/Library/LaunchAgents/com.toms.gateway.plist`，登录后自动启动，退出后自动拉起。`macos/` 下的其他脚本和 Windows 一一对应（`status.sh`、`stop.sh`、`logs.sh --errors --follow`、`start.sh`、`opencode-auth.sh`、`uninstall-service.sh`）。

请用要运行 Gateway 的那个用户，在已经登录的桌面里打开「终端」执行。不要加 `sudo`，也不要从 SSH 里执行。SSH 会话没有图形登录域，`launchctl bootstrap` 会报 `125: Domain does not support specified action`。停服务和查看状态也同样要在桌面终端里做。`Bootstrap failed: 5: Input/output error` 表示同名服务已经注册，或当前系统上 `bootstrap` 没有生效；安装脚本会先卸掉旧服务，不行再改用 `launchctl load`。

### 升级

1. 运行 `stop`
2. 用新版本覆盖安装目录
3. 再运行一次 `install-service`

配置、数据库和日志都在用户数据目录，升级不会丢失。

## 手机访问

Gateway 只监听 `127.0.0.1:3701`。在装了 Tailscale 的那台电脑上执行：

```bash
tailscale serve --bg 3701
```

然后在手机上打开 Tailscale 给出的 https 地址。`COOKIE_SECURE=true` 时必须走这个 https 地址，登录才能保持。只在本机用 `http://127.0.0.1:3701` 访问的话，把它改为 `false`。

## Cursor 和 OpenCode 的准备

- **Cursor**：在 [Cursor Dashboard](https://cursor.com/dashboard) 的 Integrations 页面创建 User API Key，填入 `CURSOR_API_KEY`。
  - 费用计入你自己的订阅
  - 本机装不装 Cursor 程序都可以，SDK 只认这个 Key
  - 如果 agent 要用某个需要 OAuth 登录的 MCP，先在 Cursor 程序里登录一次，SDK 会复用这份登录
- **OpenCode**：安装包里已经带了 OpenCode 1.18.32，Gateway 会在后台用 `opencode serve` 启动它，本机另外装的 OpenCode 不影响 Gateway。你需要准备的是模型的 API Key：
  - 运行一次 `opencode-auth`，或者把 `DEEPSEEK_API_KEY`、`OPENAI_API_KEY` 这类变量写进 `gateway.env`
  - 然后设置 `OPENCODE_ENABLE=true`
  - OpenCode 官方在 Windows 上更推荐 WSL，原生 Windows 下部分 shell 相关功能可能表现不一致

## 本地运行需要注意

- **没有隔离**：agent 拥有你用户账号的全部权限。`WORKSPACE_ROOTS` 只限制网页里能添加哪些 workspace，限制不了 agent 执行的命令。建议：
  - 用用户级的 `~/.cursor/hooks.json` 拦截危险命令
  - 不要用管理员身份运行
- **macOS 隐私权限**：后台服务访问 `~/Documents`、`~/Desktop`、`~/Downloads` 和 iCloud 目录会被系统拒绝。两种解决办法：
  - 把 workspace 放在 `~/code` 这类目录
  - 在「系统设置 > 隐私与安全性 > 完全磁盘访问权限」里加上安装目录下的 `node/bin/node`。升级后路径不变就不用重新授权
- **macOS 的 PATH**：服务的 PATH 已经加上 `/opt/homebrew/bin` 和 `/usr/local/bin`。如果 git 或其他工具装在别处，需要改 `install-service.sh` 里的 `SERVICE_PATH`。
- **睡眠**：电脑睡眠后服务也会停。需要常开的机器请在电源设置里关闭睡眠。
- **只在登录后运行**：服务在你登录后才启动，因为 agent 需要你的登录环境。
- **端口占用**：3701 或 3702 被占用时脚本会直接提示，先运行 `status` 或 `stop` 检查。

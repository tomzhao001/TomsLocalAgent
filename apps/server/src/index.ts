import { mkdirSync } from "node:fs";
import { buildApp } from "./app.js";
import { applyEnvFile, loadConfig } from "./config.js";
import { loadCursorRuntime, loadOpenCodeRuntime, type OpenCodeHandle } from "./providers/live.js";
import type { AgentRuntime } from "./runs.js";

const config = loadConfig();
applyEnvFile(config);
mkdirSync(config.logDir, { recursive: true });

const runtimes: Partial<Record<string, AgentRuntime>> = {};
let opencode: OpenCodeHandle | null = null;

if (!config.fakeRuntime && config.cursorApiKey) {
  runtimes.cursor = await loadCursorRuntime(config.cursorApiKey);
}
if (!config.fakeRuntime && config.opencode.enabled) {
  if (config.opencode.password) process.env.OPENCODE_SERVER_PASSWORD = config.opencode.password;
  try {
    opencode = await loadOpenCodeRuntime({ port: config.opencode.port, password: config.opencode.password });
  } catch (error) {
    console.error(`OpenCode 服务启动失败（端口 ${config.opencode.port}）：${(error as Error).message}`);
    process.exit(1);
  }
  runtimes.opencode = opencode.runtime;
}

const app = await buildApp({
  dbPath: config.dbPath,
  adminPassword: config.adminPassword,
  cookieSecure: config.cookieSecure,
  workspaceRoots: config.workspaceRoots,
  logDir: config.logDir,
  webDir: config.webDir,
  agentRuntime: config.fakeRuntime ? "fake" : undefined,
  runtimes,
  dispatchIntervalMs: config.dispatchIntervalMs,
  workflowModel: config.workflowModel,
  reviewModel: config.reviewModel,
});

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(`收到 ${signal}，正在退出`);
  opencode?.close();
  await app.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
    console.error(`端口 ${config.port} 已被占用。请先运行 status 查看，或运行 stop 停掉旧进程。`);
    opencode?.close();
    process.exit(1);
  }
  throw error;
}
console.log(`Gateway 已启动：http://${config.host}:${config.port}（数据目录 ${config.dataDir}）`);

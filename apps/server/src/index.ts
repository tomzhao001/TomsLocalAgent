import { delimiter } from "node:path";
import { buildApp } from "./app.js";
import { loadCursorRuntime, loadOpenCodeRuntime } from "./providers/live.js";
import type { AgentRuntime } from "./runs.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const dataDir = process.env.DATA_DIR ?? "data";
const dbPath = `${dataDir}/gateway.db`;
const adminPassword = process.env.ADMIN_PASSWORD ?? "";
if (!adminPassword) {
  throw new Error("ADMIN_PASSWORD is required");
}

const runtimes: Partial<Record<string, AgentRuntime>> = {};
const memory = new Map<string, string>();
if (process.env.AGENT_RUNTIME !== "fake" && process.env.CURSOR_API_KEY) {
  runtimes.cursor = await loadCursorRuntime(process.env.CURSOR_API_KEY, {
    get: (id) => memory.get(id) ?? null,
    set: (id, agentId) => memory.set(id, agentId),
  });
}
if (process.env.AGENT_RUNTIME !== "fake" && process.env.OPENCODE_ENABLE === "true") {
  runtimes.opencode = await loadOpenCodeRuntime();
}

const app = await buildApp({
  dbPath,
  adminPassword,
  cookieSecure: process.env.COOKIE_SECURE === "true",
  workspaceRoots: (process.env.WORKSPACE_ROOTS ?? "")
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean),
  logDir: `${dataDir}/logs`,
  agentRuntime: process.env.AGENT_RUNTIME === "fake" ? "fake" : undefined,
  runtimes,
});
await app.listen({ port, host });

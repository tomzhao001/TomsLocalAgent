import { existsSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { openDatabase } from "./db.js";
import { registerAuth } from "./auth.js";
import { registerWorkspaces } from "./workspaces.js";
import { createFakeRuntime, registerRuns, type AgentRuntime } from "./runs.js";

export type AppOptions = {
  dbPath: string;
  adminPassword: string;
  cookieSecure?: boolean;
  workspaceRoots?: string[];
  logDir?: string;
  webDir?: string;
  agentRuntime?: "fake";
  runtime?: AgentRuntime | null;
  runtimes?: Partial<Record<string, AgentRuntime>>;
};

export async function buildApp(options?: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.get("/healthz", async () => ({ ok: true }));

  if (options) {
    const db = openDatabase(options.dbPath);
    app.addHook("onClose", async () => {
      db.close();
    });
    await registerAuth(app, db, {
      adminPassword: options.adminPassword,
      cookieSecure: options.cookieSecure !== false,
    });
    await registerWorkspaces(app, db, options.workspaceRoots ?? []);
    const runtime =
      options.runtime ?? (options.agentRuntime === "fake" ? createFakeRuntime() : null);
    registerRuns(app, db, { logDir: options.logDir ?? "data/logs", runtime, runtimes: options.runtimes });
  }

  if (options?.webDir && existsSync(join(options.webDir, "index.html"))) {
    await registerWeb(app, options.webDir);
  }

  return app;
}

async function registerWeb(app: FastifyInstance, webDir: string): Promise<void> {
  await app.register(fastifyStatic, { root: webDir, wildcard: false });
  app.setNotFoundHandler(async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    if (request.method !== "GET" || path.startsWith("/api/") || path === "/healthz") {
      return reply.code(404).send({ error: "not_found", message: "接口不存在" });
    }
    return reply.type("text/html").sendFile("index.html");
  });
}

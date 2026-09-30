import { existsSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { openDatabase } from "./db.js";
import { registerAuth } from "./auth.js";
import { WorkspaceLockManager } from "./locks.js";
import { registerWorkspaces } from "./workspaces.js";
import { createFakeRuntime, recoverInterruptedRuns, registerRuns, type AgentRuntime } from "./runs.js";
import { registerWorkflows } from "./workflows.js";
import { Dispatcher } from "./workflows/_framework/dispatcher.js";
import { SplitRunner } from "./workflows/_framework/split-task.js";

declare module "fastify" {
  interface FastifyInstance {
    dispatcher?: Dispatcher;
    splits?: SplitRunner;
  }
}

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
  dispatchIntervalMs?: number;
  workflowModel?: string;
  reviewModel?: string;
  pickDirectory?: () => Promise<string | null>;
};

export async function buildApp(options?: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.get("/healthz", async () => ({ ok: true }));

  if (options) {
    const db = openDatabase(options.dbPath);
    const logDir = options.logDir ?? "data/logs";
    const runtime =
      options.runtime ?? (options.agentRuntime === "fake" ? createFakeRuntime() : null);
    const workflowRuntime = () => options.runtimes?.cursor ?? runtime;
    const model = options.workflowModel ?? "auto";
    const locks = new WorkspaceLockManager(db);
    recoverInterruptedRuns(db, logDir);
    locks.clearStale();
    const dispatcher = new Dispatcher({
      db,
      logDir,
      locks,
      runtime: workflowRuntime,
      model,
      reviewModel: options.reviewModel,
      intervalMs: options.dispatchIntervalMs,
    });
    const splits = new SplitRunner(db, { logDir, runtime: workflowRuntime, model });
    app.decorate("dispatcher", dispatcher);
    app.decorate("splits", splits);
    app.addHook("onClose", async () => {
      await dispatcher.stop();
      await splits.stop();
      db.close();
    });
    await registerAuth(app, db, {
      adminPassword: options.adminPassword,
      cookieSecure: options.cookieSecure !== false,
    });
    await registerWorkspaces(app, db, { pickDirectory: options.pickDirectory });
    registerRuns(app, db, { logDir, locks, runtime, runtimes: options.runtimes });
    registerWorkflows(app, db, { logDir, dispatcher, splits });
    dispatcher.start();
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

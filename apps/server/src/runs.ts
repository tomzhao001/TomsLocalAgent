import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import type { GatewayEvent } from "@gateway/shared";
import { dbOpen } from "./db.js";
import { appendLog, logFile, readLog } from "./logs.js";
import type { WorkspaceLockManager } from "./locks.js";
import type { AccessProfile } from "./providers/access.js";
import { readonlyViolation, watchReadonly } from "./providers/guard.js";

export type GatewayToolResult = string | { content: { type: "text"; text: string }[]; isError?: boolean };

export type GatewayTool = {
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => GatewayToolResult | Promise<GatewayToolResult>;
};

export type RunContext = {
  sessionId: string;
  runId: string;
  workspaceId: string;
  prompt: string;
  model: string;
  cwd: string;
  access?: AccessProfile;
  agentId?: string | null;
  onAgent?: (agentId: string) => void;
  customTools?: Record<string, GatewayTool>;
};

export type RunTerminal = "finished" | "error" | "cancelled";

export type AgentRuntime = {
  startRun(input: RunContext, emit: (event: GatewayEvent) => void, signal?: AbortSignal): Promise<RunTerminal | void>;
  listModels?: () => Promise<{ id: string; label: string }[]>;
};

export function createFakeRuntime(): AgentRuntime {
  return {
    async startRun(input, emit) {
      await delay(Number(process.env.FAKE_DELAY_MS ?? 120));
      emit({ type: "text", text: input.prompt });
      const tools = input.customTools ?? {};
      if (tools.submit_requirements) {
        await tools.submit_requirements.execute({
          sharedContext: input.prompt.slice(0, 200),
          cards: [
            {
              title: "示例需求",
              goal: "假运行生成的示例需求",
              context: input.prompt.slice(0, 200) || "无",
              acceptanceCriteria: ["能在工作流页面看到这张卡"],
            },
          ],
        });
      } else if (tools.submit_verdict) {
        await tools.submit_verdict.execute({ verdict: "pass", comments: "假运行自动通过" });
      }
      await delay(20);
      emit({ type: "done", status: "finished" });
    },
  };
}

export function registerRuns(
  app: FastifyInstance,
  db: DatabaseSync,
  options: {
    logDir: string;
    locks: WorkspaceLockManager;
    runtime: AgentRuntime | null;
    runtimes?: Partial<Record<string, AgentRuntime>>;
  },
): void {
  const locks = options.locks;
  const controllers = new Map<string, AbortController>();

  app.post("/api/sessions/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = db.prepare("SELECT id, workspace_id, provider, agent_id FROM chat_sessions WHERE id = ?").get(id) as
      | { id: string; workspace_id: string; provider: string; agent_id: string | null }
      | undefined;
    if (!session) return reply.code(404).send({ error: "not_found", message: "聊天不存在" });
    const runtime = options.runtimes?.[session.provider] ?? options.runtime;
    if (!runtime) return reply.code(501).send({ error: "no_runtime", message: "当前没有可用的 agent" });
    const body = request.body as { prompt?: string; model?: string };
    if (!body.prompt?.trim()) return reply.code(400).send({ error: "invalid", message: "prompt 必填" });

    const workspace = db.prepare("SELECT path, repos_json FROM workspaces WHERE id = ?").get(session.workspace_id) as {
      path: string;
      repos_json: string;
    };
    const runId = randomUUID();
    const acquired = locks.tryAcquire(session.workspace_id, "chat", { type: "run", id: runId });
    if (!acquired.ok) {
      return reply.code(409).send({
        error: "locked",
        message: "这个 workspace 的另一个聊天正在回答，请稍后再发",
        holder: acquired.holder,
      });
    }
    const model = body.model ?? "";
    db.prepare(
      "INSERT INTO runs (id, workspace_id, session_id, status, model, prompt, created_at) VALUES (?, ?, ?, 'running', ?, ?, ?)",
    ).run(runId, session.workspace_id, session.id, model, body.prompt, Date.now());
    const file = logFile(options.logDir, session.id, runId);
    const ctx: RunContext = {
      sessionId: session.id,
      runId,
      workspaceId: session.workspace_id,
      prompt: body.prompt,
      model,
      cwd: workspace.path,
      access: "chat",
      agentId: session.agent_id,
      onAgent: (agentId) => {
        if (dbOpen(db)) db.prepare("UPDATE chat_sessions SET agent_id = ? WHERE id = ?").run(agentId, session.id);
      },
    };
    const controller = new AbortController();
    controllers.set(runId, controller);
    const repos = JSON.parse(workspace.repos_json) as string[];
    void (async () => {
      const changed = await watchReadonly(repos);
      try {
        const status = await runtime.startRun(ctx, (event) => appendLog(file, event), controller.signal);
        if (await changed()) appendLog(file, { type: "error", message: readonlyViolation });
        if (dbOpen(db)) db.prepare("UPDATE runs SET status = ? WHERE id = ?").run(status ?? "finished", runId);
      } catch {
        if (!dbOpen(db)) return;
        appendLog(file, { type: "error", message: "run failed" });
        db.prepare("UPDATE runs SET status = 'error' WHERE id = ?").run(runId);
      } finally {
        controllers.delete(runId);
        if (dbOpen(db)) locks.release(session.workspace_id, "chat", runId);
      }
    })();
    return reply.code(202).send({ runId });
  });

  app.post("/api/runs/:id/cancel", async (request, reply) => {
    const { id } = request.params as { id: string };
    const controller = controllers.get(id);
    if (!controller) return reply.code(409).send({ error: "not_running", message: "这个运行已经结束" });
    controller.abort();
    return { ok: true };
  });

  app.get("/api/providers/:id/models", async (request, reply) => {
    const { id } = request.params as { id: string };
    const runtime = options.runtimes?.[id] ?? options.runtime;
    if (!runtime?.listModels) return reply.code(404).send({ error: "not_found", message: "没有这个 provider" });
    try {
      return await runtime.listModels();
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : "模型列表读取失败";
      return reply.code(502).send({ error: "models_unavailable", message });
    }
  });

  app.get("/api/sessions", async (request) => {
    const { workspaceId } = request.query as { workspaceId?: string };
    const base = `SELECT s.id, s.provider, s.workspace_id, s.title, w.name AS workspace_name
         FROM chat_sessions s JOIN workspaces w ON w.id = s.workspace_id`;
    if (workspaceId) {
      return db.prepare(`${base} WHERE s.workspace_id = ? ORDER BY s.created_at DESC`).all(workspaceId);
    }
    return db.prepare(`${base} ORDER BY s.created_at DESC`).all();
  });

  app.get("/api/sessions/:id/runs", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = db.prepare("SELECT id FROM chat_sessions WHERE id = ?").get(id);
    if (!session) return reply.code(404).send({ error: "not_found", message: "聊天不存在" });
    return db
      .prepare("SELECT id, status, prompt, created_at FROM runs WHERE session_id = ? ORDER BY created_at")
      .all(id);
  });

  app.get("/api/runs/:id/log", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = db.prepare("SELECT id, session_id, status FROM runs WHERE id = ?").get(id) as
      | { id: string; session_id: string; status: string }
      | undefined;
    if (!run) return reply.code(404).send({ error: "not_found", message: "run 不存在" });
    const offset = Number((request.query as { offset?: string }).offset ?? 0);
    const file = logFile(options.logDir, run.session_id, run.id);
    const { events, nextOffset } = readLog(file, Number.isFinite(offset) ? offset : 0);
    return { events, nextOffset, status: run.status };
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { requirementCardSchema, type RequirementCard } from "@gateway/shared";
import { transaction } from "./db.js";
import { readLog } from "./logs.js";
import type { Dispatcher, RequirementRow, StepRunRow, WaitInfo } from "./workflows/_framework/dispatcher.js";
import { stepLogFile } from "./workflows/_framework/dispatcher.js";
import { appendRequirements, splitLogFile, type SplitRunner, type SplitTaskRow } from "./workflows/_framework/split-task.js";
import { normalizeLoopState, normalizeStepId, type DevLoopState, type InputAction } from "./workflows/cursor-dev-loop/next.js";

const inputActions: InputAction[] = ["answer", "continue", "forcePass", "abort"];
const historyPageSize = 20;

export function registerWorkflows(
  app: FastifyInstance,
  db: DatabaseSync,
  options: { logDir: string; dispatcher: Dispatcher; splits: SplitRunner },
): void {
  const { dispatcher, splits } = options;

  app.get("/api/workflow/status", async () => {
    const rows = db
      .prepare(
        `SELECT w.id,
           (SELECT COUNT(*) FROM requirements r WHERE r.workspace_id = w.id AND r.status = 'waiting_input') AS waiting,
           (SELECT COUNT(*) FROM requirements r WHERE r.workspace_id = w.id AND r.status = 'running') AS running,
           (SELECT COUNT(*) FROM requirements r WHERE r.workspace_id = w.id AND r.status = 'pending') AS pending,
           (SELECT COUNT(*) FROM split_tasks s WHERE s.workspace_id = w.id AND s.status = 'running') AS splitting,
           (SELECT COUNT(*) FROM split_tasks s WHERE s.workspace_id = w.id AND s.status = 'draft') AS drafts
         FROM workspaces w WHERE w.archived = 0`,
      )
      .all() as { id: string; waiting: number; running: number; pending: number; splitting: number; drafts: number }[];
    return rows.map((row) => {
      const waiting = Number(row.waiting);
      const busy = Number(row.running) + Number(row.pending) + Number(row.splitting);
      return {
        workspaceId: row.id,
        status: waiting > 0 ? "waiting_input" : busy > 0 ? "running" : "idle",
        pending: Number(row.pending),
        drafts: Number(row.drafts),
        splitting: Number(row.splitting),
      };
    });
  });

  app.get("/api/workspaces/:id/requirements", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!workspaceExists(db, id)) return reply.code(404).send({ error: "not_found", message: "workspace 不存在" });
    const query = request.query as { scope?: string; before?: string };
    if (query.scope === "history") {
      const before = Number(query.before);
      const rows = db
        .prepare(
          `SELECT * FROM requirements
           WHERE workspace_id = ? AND status IN ('delivered', 'aborted') AND finished_at < ?
           ORDER BY finished_at DESC LIMIT ?`,
        )
        .all(id, Number.isFinite(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER, historyPageSize + 1) as RequirementRow[];
      const page = rows.slice(0, historyPageSize);
      return {
        items: page.map((row) => requirementDto(db, row, false)),
        features: featuresFor(db, page),
        hasMore: rows.length > historyPageSize,
      };
    }
    const rows = db
      .prepare(
        `SELECT * FROM requirements WHERE workspace_id = ? AND status IN ('pending', 'running', 'waiting_input')
         ORDER BY seq`,
      )
      .all(id) as RequirementRow[];
    return { items: rows.map((row) => requirementDto(db, row, true)), features: featuresFor(db, rows) };
  });

  app.get("/api/requirements/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = db.prepare("SELECT * FROM requirements WHERE id = ?").get(id) as RequirementRow | undefined;
    if (!row) return reply.code(404).send({ error: "not_found", message: "需求卡不存在" });
    return requirementDto(db, row, true);
  });

  app.post("/api/workspaces/:id/requirements", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspace = db.prepare("SELECT archived FROM workspaces WHERE id = ?").get(id) as { archived: number } | undefined;
    if (!workspace) return reply.code(404).send({ error: "not_found", message: "workspace 不存在" });
    if (workspace.archived) return reply.code(409).send({ error: "archived", message: "已归档的 workspace 不能新增需求" });
    const parsed = requirementCardSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid", message: "标题、目标、背景和至少一条验收标准都必填" });
    }
    const [created] = transaction(db, () => appendRequirements(db, id, null, [parsed.data]));
    return reply.code(201).send(requirementDto(db, loadRequirement(db, created!)!, true));
  });

  app.delete("/api/requirements/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = loadRequirement(db, id);
    if (!row) return reply.code(404).send({ error: "not_found", message: "需求卡不存在" });
    if (row.status !== "pending") return reply.code(409).send({ error: "not_pending", message: "只能删除还没开始的需求卡" });
    db.prepare("DELETE FROM requirements WHERE id = ?").run(id);
    return reply.code(204).send();
  });

  app.post("/api/requirements/:id/input", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { action?: string; text?: string };
    const action = inputActions.find((item) => item === body?.action);
    if (!action) return reply.code(400).send({ error: "invalid", message: "不支持的操作" });
    const text = body.text?.trim() ?? "";
    const row = loadRequirement(db, id);
    const wait = row?.wait_json ? (JSON.parse(row.wait_json) as WaitInfo) : null;
    if (!text && (action === "continue" || (action === "answer" && wait?.kind === "question"))) {
      return reply.code(400).send({ error: "invalid", message: "请填写说明" });
    }
    const result = dispatcher.applyInput(id, action, text);
    if (!result.ok) return reply.code(409).send({ error: "conflict", message: result.message });
    return requirementDto(db, loadRequirement(db, id)!, true);
  });

  app.get("/api/step-runs/:id/log", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = db.prepare("SELECT id, requirement_id, status FROM step_runs WHERE id = ?").get(id) as
      | { id: string; requirement_id: string; status: string }
      | undefined;
    if (!run) return reply.code(404).send({ error: "not_found", message: "步骤不存在" });
    const offset = Number((request.query as { offset?: string }).offset ?? 0);
    const { events, nextOffset } = readLog(
      stepLogFile(options.logDir, run.requirement_id, run.id),
      Number.isFinite(offset) ? offset : 0,
    );
    return { events, nextOffset, status: run.status };
  });

  app.post("/api/workspaces/:id/splits", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { prompt?: string; chatSessionId?: string; model?: string };
    if (!body?.prompt?.trim()) return reply.code(400).send({ error: "invalid", message: "请填写拆卡要求" });
    const result = splits.start({
      workspaceId: id,
      prompt: body.prompt.trim(),
      chatSessionId: body.chatSessionId || undefined,
      model: body.model || undefined,
    });
    if (!result.ok) return reply.code(result.code).send({ error: "split_failed", message: result.message });
    return reply.code(202).send(splitDto(splits.load(result.id)!));
  });

  app.get("/api/workspaces/:id/splits", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!workspaceExists(db, id)) return reply.code(404).send({ error: "not_found", message: "workspace 不存在" });
    const rows = db
      .prepare(
        `SELECT * FROM split_tasks WHERE workspace_id = ? AND status IN ('running', 'draft', 'failed')
         ORDER BY created_at DESC`,
      )
      .all(id) as SplitTaskRow[];
    return rows.map(splitDto);
  });

  app.post("/api/splits/:id/confirm", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { title?: string; sharedContext?: unknown; cards?: unknown };
    const result = splits.confirm(id, { sharedContext: body?.sharedContext, cards: body?.cards }, body?.title);
    if (!result.ok) return reply.code(result.code).send({ error: "confirm_failed", message: result.message });
    return { featureId: result.featureId };
  });

  app.post("/api/splits/:id/discard", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = splits.discard(id);
    if (!result.ok) return reply.code(result.code).send({ error: "discard_failed", message: result.message });
    return { ok: true };
  });

  app.get("/api/splits/:id/log", async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = splits.load(id);
    if (!row) return reply.code(404).send({ error: "not_found", message: "拆卡不存在" });
    const offset = Number((request.query as { offset?: string }).offset ?? 0);
    const { events, nextOffset } = readLog(splitLogFile(options.logDir, id), Number.isFinite(offset) ? offset : 0);
    return { events, nextOffset, status: row.status };
  });
}

function requirementDto(db: DatabaseSync, row: RequirementRow, withSteps: boolean) {
  const state: DevLoopState | null = row.state_json ? normalizeLoopState(JSON.parse(row.state_json)) : null;
  const steps = withSteps
    ? (db
        .prepare("SELECT * FROM step_runs WHERE requirement_id = ? ORDER BY started_at, rowid")
        .all(row.id) as StepRunRow[])
    : [];
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    featureId: row.feature_id,
    seq: row.seq,
    card: JSON.parse(row.card_json) as RequirementCard,
    status: row.status,
    phase: state?.phase ?? null,
    reviewRejects: state?.reviewRejects ?? 0,
    wait: row.wait_json ? normalizeWait(JSON.parse(row.wait_json) as WaitInfo) : null,
    hasAgent: Boolean(row.agent_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    version: row.version,
    steps: steps.map((step) => ({
      id: step.id,
      step: step.step,
      attempt: step.attempt,
      status: step.status,
      result: step.result_json ? JSON.parse(step.result_json) : null,
      note: step.user_input,
      startedAt: step.started_at,
      endedAt: step.ended_at,
    })),
  };
}

function normalizeWait(wait: WaitInfo): WaitInfo {
  const from = String(wait.fromStep);
  return { ...wait, fromStep: from === "qa" ? "review" : normalizeStepId(from) };
}

function featuresFor(db: DatabaseSync, rows: RequirementRow[]) {
  const ids = [...new Set(rows.map((row) => row.feature_id).filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return [];
  const features = db
    .prepare(`SELECT id, title, shared_context, created_at FROM features WHERE id IN (${ids.map(() => "?").join(",")})`)
    .all(...ids) as { id: string; title: string; shared_context: string; created_at: number }[];
  return features.map((feature) => {
    const counts = db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered
         FROM requirements WHERE feature_id = ?`,
      )
      .get(feature.id) as { total: number; delivered: number | null };
    return {
      id: feature.id,
      title: feature.title,
      sharedContext: feature.shared_context,
      createdAt: feature.created_at,
      total: Number(counts.total),
      delivered: Number(counts.delivered ?? 0),
    };
  });
}

function splitDto(row: SplitTaskRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    chatSessionId: row.chat_session_id,
    prompt: row.prompt,
    status: row.status,
    draft: row.draft_json ? JSON.parse(row.draft_json) : null,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function loadRequirement(db: DatabaseSync, id: string): RequirementRow | undefined {
  return db.prepare("SELECT * FROM requirements WHERE id = ?").get(id) as RequirementRow | undefined;
}

function workspaceExists(db: DatabaseSync, id: string): boolean {
  return Boolean(db.prepare("SELECT id FROM workspaces WHERE id = ?").get(id));
}

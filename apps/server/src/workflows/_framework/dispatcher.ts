import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { RequirementCard, RequirementStatus, StepRunStatus } from "@gateway/shared";
import { dbOpen } from "../../db.js";
import { appendLog } from "../../logs.js";
import type { WorkspaceLockManager } from "../../locks.js";
import type { AccessProfile } from "../../providers/access.js";
import type { AgentRuntime } from "../../runs.js";
import {
  defaultLoopConfig,
  initialLoopState,
  nextLoop,
  type DevLoopState,
  type InputAction,
  type LoopAction,
  type LoopConfig,
  type LoopEvent,
  type StepId,
  type WaitKind,
} from "../cursor-dev-loop/next.js";
import { stepPrompt } from "../cursor-dev-loop/prompts.js";
import { parseResultBlock, stepTools, toLoopEvent, type StepResult } from "./result.js";

export type RequirementRow = {
  id: string;
  workspace_id: string;
  feature_id: string | null;
  seq: number;
  card_json: string;
  status: RequirementStatus;
  agent_id: string | null;
  state_json: string | null;
  pending_action_json: string | null;
  wait_json: string | null;
  version: number;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
};

export type StepRunRow = {
  id: string;
  requirement_id: string;
  step: StepId;
  attempt: number;
  status: StepRunStatus;
  result_json: string | null;
  consumed: number;
  user_input: string | null;
  started_at: number;
  ended_at: number | null;
};

export type WaitInfo = {
  kind: WaitKind;
  fromStep: StepId;
  message: string;
  comments?: string;
  options: InputAction[];
};

type RunStepAction = Extract<LoopAction, { kind: "runStep" }> & { comments?: string };

const stepAccess: Record<StepId, AccessProfile> = {
  develop: "develop",
  arch: "review",
  qa: "qa",
  devops: "devops",
};

export function stepLogFile(logDir: string, requirementId: string, stepRunId: string): string {
  return `${logDir}/requirements/${requirementId}/${stepRunId}.ndjson`;
}

export type DispatcherOptions = {
  db: DatabaseSync;
  logDir: string;
  locks: WorkspaceLockManager;
  runtime: () => AgentRuntime | null;
  model: string;
  cfg?: LoopConfig;
  intervalMs?: number;
};

export class Dispatcher {
  private readonly db: DatabaseSync;
  private readonly cfg: LoopConfig;
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private readonly options: DispatcherOptions) {
    this.db = options.db;
    this.cfg = options.cfg ?? defaultLoopConfig;
  }

  start(): void {
    const interval = this.options.intervalMs ?? 60_000;
    if (interval <= 0 || this.timer) return;
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const pending = [...this.active.values()];
    for (const item of pending) item.controller.abort();
    await Promise.allSettled(pending.map((item) => item.done));
  }

  async idle(): Promise<void> {
    await Promise.allSettled([...this.active.values()].map((item) => item.done));
  }

  async tick(): Promise<void> {
    if (this.ticking || !dbOpen(this.db)) return;
    this.ticking = true;
    try {
      const rows = this.db
        .prepare(
          `SELECT DISTINCT workspace_id FROM requirements WHERE status IN ('pending', 'running', 'waiting_input')
           UNION SELECT workspace_id FROM workspace_locks WHERE kind = 'workflow'`,
        )
        .all() as { workspace_id: string }[];
      for (const row of rows) this.advance(row.workspace_id);
    } finally {
      this.ticking = false;
    }
  }

  applyInput(requirementId: string, action: InputAction, text: string): { ok: true } | { ok: false; message: string } {
    const row = this.load(requirementId);
    if (!row) return { ok: false, message: "需求卡不存在" };
    if (action === "abort" && (row.status === "running" || row.status === "waiting_input")) {
      this.cancelRunning(row.id);
      this.save(row, { state: { ...this.state(row), phase: "aborted" }, action: { kind: "aborted" } });
      return { ok: true };
    }
    if (row.status !== "waiting_input") return { ok: false, message: "这张卡当前不在等待输入" };
    const wait = row.wait_json ? (JSON.parse(row.wait_json) as WaitInfo) : null;
    if (wait && !wait.options.includes(action)) return { ok: false, message: "当前不支持这个操作" };
    const event: LoopEvent =
      action === "answer"
        ? { type: "answer", text }
        : action === "continue"
          ? { type: "continue", text }
          : action === "forcePass"
            ? { type: "forcePass" }
            : { type: "abort" };
    this.save(row, nextLoop(this.state(row), event, this.cfg));
    return { ok: true };
  }

  private advance(workspaceId: string): void {
    let head = this.head(workspaceId);
    if (!head) {
      const next = this.db
        .prepare("SELECT * FROM requirements WHERE workspace_id = ? AND status = 'pending' ORDER BY seq LIMIT 1")
        .get(workspaceId) as RequirementRow | undefined;
      if (!next) {
        this.options.locks.release(workspaceId, "workflow", workspaceId);
        return;
      }
      if (!this.options.runtime()) return;
      if (!this.options.locks.tryAcquire(workspaceId, "workflow", { type: "workflow", id: workspaceId }).ok) return;
      this.save(next, nextLoop(initialLoopState(1), { type: "start" }, this.cfg));
      head = this.load(next.id)!;
    }
    if (head.status !== "running") return;
    this.options.locks.tryAcquire(workspaceId, "workflow", { type: "workflow", id: workspaceId });

    const latest = this.db
      .prepare("SELECT * FROM step_runs WHERE requirement_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1")
      .get(head.id) as StepRunRow | undefined;
    if (latest?.status === "running") {
      if (this.active.has(latest.id)) return;
      this.db
        .prepare("UPDATE step_runs SET status = 'interrupted', ended_at = ? WHERE id = ?")
        .run(Date.now(), latest.id);
      latest.status = "interrupted";
    }
    let comments: string | undefined;
    if (latest && latest.consumed === 0) {
      const result = latest.result_json ? (JSON.parse(latest.result_json) as StepResult) : null;
      const event = latest.status === "finished" ? toLoopEvent(latest.step, result) : ({ type: "techError" } as const);
      if (result && result.verdict !== "need_input") comments = result.comments;
      this.db.prepare("UPDATE step_runs SET consumed = 1 WHERE id = ?").run(latest.id);
      this.save(head, nextLoop(this.state(head), event, this.cfg), comments);
      head = this.load(head.id)!;
      if (head.status !== "running") return;
    }
    const pending = head.pending_action_json ? (JSON.parse(head.pending_action_json) as RunStepAction) : null;
    if (pending?.kind === "runStep") this.launch(head, pending);
  }

  private launch(row: RequirementRow, action: RunStepAction): void {
    const runtime = this.options.runtime();
    if (!runtime) return;
    const workspace = this.db.prepare("SELECT path FROM workspaces WHERE id = ?").get(row.workspace_id) as
      | { path: string }
      | undefined;
    if (!workspace) return;
    const card = JSON.parse(row.card_json) as RequirementCard;
    const feature = row.feature_id
      ? (this.db.prepare("SELECT shared_context FROM features WHERE id = ?").get(row.feature_id) as
          | { shared_context: string }
          | undefined)
      : undefined;
    const attempt =
      Number(
        (
          this.db
            .prepare("SELECT COUNT(*) AS n FROM step_runs WHERE requirement_id = ? AND step = ?")
            .get(row.id, action.nodeId) as { n: number }
        ).n,
      ) + 1;
    const stepRunId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO step_runs (id, requirement_id, step, attempt, status, consumed, user_input, started_at)
         VALUES (?, ?, ?, ?, 'running', 0, ?, ?)`,
      )
      .run(stepRunId, row.id, action.nodeId, attempt, action.prompt, Date.now());
    this.db
      .prepare("UPDATE requirements SET version = version + 1, updated_at = ? WHERE id = ?")
      .run(Date.now(), row.id);

    const file = stepLogFile(this.options.logDir, row.id, stepRunId);
    const texts: string[] = [];
    let recorded: StepResult | null = null;
    const controller = new AbortController();
    const prompt = stepPrompt({
      step: action.nodeId,
      card,
      sharedContext: feature?.shared_context ?? "",
      note: action.prompt,
      comments: action.comments,
      firstTurn: !row.agent_id,
    });
    const done = (async () => {
      let status: StepRunRow["status"] = "finished";
      try {
        const terminal = await runtime.startRun(
          {
            sessionId: `req:${row.id}`,
            runId: stepRunId,
            workspaceId: row.workspace_id,
            prompt,
            model: this.options.model,
            cwd: workspace.path,
            access: stepAccess[action.nodeId],
            agentId: row.agent_id,
            onAgent: (agentId) => {
              if (dbOpen(this.db)) this.db.prepare("UPDATE requirements SET agent_id = ? WHERE id = ?").run(agentId, row.id);
            },
            customTools: stepTools((result) => {
              recorded = result;
            }),
          },
          (event) => {
            if (event.type === "text") texts.push(event.text);
            appendLog(file, event);
          },
          controller.signal,
        );
        status = terminal ?? "finished";
      } catch {
        status = "error";
        appendLog(file, { type: "error", message: "run failed" });
      } finally {
        this.active.delete(stepRunId);
        if (dbOpen(this.db)) {
          const result = recorded ?? parseResultBlock(texts);
          this.db
            .prepare(
              "UPDATE step_runs SET status = ?, result_json = ?, ended_at = ? WHERE id = ? AND status = 'running'",
            )
            .run(status, result ? JSON.stringify(result) : null, Date.now(), stepRunId);
          this.db
            .prepare("UPDATE requirements SET version = version + 1, updated_at = ? WHERE id = ?")
            .run(Date.now(), row.id);
        }
      }
    })();
    this.active.set(stepRunId, { controller, done });
  }

  private cancelRunning(requirementId: string): void {
    const rows = this.db
      .prepare("SELECT id FROM step_runs WHERE requirement_id = ? AND status = 'running'")
      .all(requirementId) as { id: string }[];
    for (const item of rows) {
      this.active.get(item.id)?.controller.abort();
      this.db
        .prepare("UPDATE step_runs SET status = 'cancelled', consumed = 1, ended_at = ? WHERE id = ?")
        .run(Date.now(), item.id);
    }
  }

  private save(row: RequirementRow, outcome: { state: DevLoopState; action: LoopAction }, comments?: string): void {
    const now = Date.now();
    const { state, action } = outcome;
    let status: RequirementStatus = "running";
    let pending: RunStepAction | null = null;
    let wait: WaitInfo | null = null;
    let finishedAt: number | null = null;
    if (action.kind === "runStep") {
      pending = comments ? { ...action, comments } : action;
    } else if (action.kind === "waitInput") {
      status = "waiting_input";
      wait = { kind: action.waitKind, fromStep: action.fromStep, message: action.reason, comments, options: action.options };
    } else if (action.kind === "aborted") {
      status = "aborted";
      finishedAt = now;
    } else {
      status = "delivered";
      finishedAt = now;
    }
    this.db
      .prepare(
        `UPDATE requirements SET status = ?, state_json = ?, pending_action_json = ?, wait_json = ?,
           version = version + 1, updated_at = ?, finished_at = COALESCE(?, finished_at)
         WHERE id = ?`,
      )
      .run(
        status,
        JSON.stringify(state),
        pending ? JSON.stringify(pending) : null,
        wait ? JSON.stringify(wait) : null,
        now,
        finishedAt,
        row.id,
      );
  }

  private head(workspaceId: string): RequirementRow | undefined {
    return this.db
      .prepare("SELECT * FROM requirements WHERE workspace_id = ? AND status IN ('running', 'waiting_input') LIMIT 1")
      .get(workspaceId) as RequirementRow | undefined;
  }

  private load(id: string): RequirementRow | undefined {
    return this.db.prepare("SELECT * FROM requirements WHERE id = ?").get(id) as RequirementRow | undefined;
  }

  private state(row: RequirementRow): DevLoopState {
    return row.state_json ? (JSON.parse(row.state_json) as DevLoopState) : initialLoopState(1);
  }
}

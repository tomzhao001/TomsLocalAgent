import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { RequirementCard, RequirementStatus, StepRunStatus } from "@gateway/shared";
import { dbOpen } from "../../db.js";
import { appendLog } from "../../logs.js";
import type { WorkspaceLockManager } from "../../locks.js";
import type { AccessProfile } from "../../providers/access.js";
import { resolveStoredModel, traceFromEvent, type StepTrace } from "../../providers/map.js";
import type { AgentRuntime } from "../../runs.js";
import { scanGitRepos } from "../../paths.js";
import { collectReviewDiff } from "../cursor-dev-loop/diff.js";
import {
  defaultLoopConfig,
  initialLoopState,
  nextLoop,
  normalizeLoopState,
  normalizeStepId,
  type DevLoopState,
  type InputAction,
  type LoopAction,
  type LoopConfig,
  type ChoiceQuestion,
  type LoopEvent,
  type StepId,
  type WaitKind,
} from "../cursor-dev-loop/next.js";
import { stepPrompt } from "../cursor-dev-loop/prompts.js";
import { initialQaState, nextQa, normalizeQaState, toQaEvent, type QaAction, type QaState } from "../cursor-qa/next.js";
import { qaPrompt } from "../cursor-qa/prompts.js";
import { parseResultBlock, stepTools, toLoopEvent, type StepResult } from "./result.js";

export type RequirementRow = {
  id: string;
  workspace_id: string;
  feature_id: string | null;
  seq: number;
  card_json: string;
  workflow_id: string;
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
  fromStep: StepId | "qa";
  message: string;
  comments?: string;
  options: InputAction[];
  questions?: ChoiceQuestion[];
};

type RunStepAction = {
  kind: "runStep";
  nodeId: StepId | "qa";
  cardIndex: number;
  prompt: string;
  comments?: string;
};

const stepAccess: Record<StepId | "qa", AccessProfile> = {
  plan: "plan",
  develop: "develop",
  review: "review",
  devops: "devops",
  qa: "qa",
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
  reviewModel?: string;
  cfg?: LoopConfig;
  intervalMs?: number;
};

export function stepModel(
  step: StepId | "qa",
  workspace: { develop_model?: string | null; review_model?: string | null },
  fallback: { model: string; reviewModel?: string },
): string {
  if (step === "develop" && workspace.develop_model) return workspace.develop_model;
  if (step === "review") return workspace.review_model || fallback.reviewModel || fallback.model;
  return fallback.model;
}

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
    this.save(row, this.transition(row, event));
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
      this.save(next, this.begin(next));
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
      if (result && result.verdict !== "need_input") comments = result.comments;
      if (isQa(head)) {
        const event = latest.status === "finished" ? toQaEvent(result) : ({ type: "techError" } as const);
        this.db.prepare("UPDATE step_runs SET consumed = 1 WHERE id = ?").run(latest.id);
        this.save(head, nextQa(this.qaState(head), event), comments);
      } else if (String(latest.step) === "qa") {
        this.db.prepare("UPDATE step_runs SET consumed = 1 WHERE id = ?").run(latest.id);
        const current = this.state(head);
        this.save(head, {
          state: { ...current, phase: "devops", waitingFrom: undefined },
          action: { kind: "runStep", nodeId: "devops", cardIndex: current.index, prompt: "进入 DevOps" },
        });
      } else {
        const event = latest.status === "finished" ? toLoopEvent(normalizeStepId(latest.step), result) : ({ type: "techError" } as const);
        this.db.prepare("UPDATE step_runs SET consumed = 1 WHERE id = ?").run(latest.id);
        this.save(head, nextLoop(this.state(head), event, this.cfg), comments);
      }
      head = this.load(head.id)!;
      if (head.status !== "running") return;
    }
    const pending = head.pending_action_json ? (JSON.parse(head.pending_action_json) as RunStepAction) : null;
    if (pending?.kind === "runStep") {
      const nodeId = isQa(head) ? "qa" : normalizeStepId(pending.nodeId);
      this.launch(head, { ...pending, nodeId });
    }
  }

  private launch(row: RequirementRow, action: RunStepAction & { nodeId: StepId | "qa" }): void {
    const runtime = this.options.runtime();
    if (!runtime) return;
    const workspace = this.db
      .prepare("SELECT path, repos_json, develop_model, review_model FROM workspaces WHERE id = ?")
      .get(row.workspace_id) as
      | { path: string; repos_json: string; develop_model: string | null; review_model: string | null }
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
    const trace: StepTrace[] = [];
    let recorded: StepResult | null = null;
    const controller = new AbortController();
    const keepAgent = action.nodeId !== "review";
    const done = (async () => {
      let status: StepRunRow["status"] = "finished";
      try {
        const diff = action.nodeId === "review" ? await this.reviewDiff(workspace) : undefined;
        const sharedContext = feature?.shared_context ?? "";
        const prompt =
          action.nodeId === "qa"
            ? qaPrompt({
                card,
                sharedContext,
                note: action.prompt,
                comments: action.comments,
                firstTurn: !row.agent_id,
              })
            : stepPrompt({
                step: action.nodeId,
                card,
                sharedContext,
                note: action.prompt,
                comments: action.comments,
                firstTurn: action.nodeId === "review" || action.nodeId === "plan" || !row.agent_id,
                diff,
              });
        const storedModel = this.modelFor(action.nodeId, workspace);
        let selection = resolveStoredModel([], storedModel);
        if (runtime.listModels) {
          try {
            selection = resolveStoredModel(await runtime.listModels(), storedModel);
          } catch {
            selection = resolveStoredModel([], storedModel);
          }
        }
        const terminal = await runtime.startRun(
          {
            sessionId: `req:${row.id}`,
            runId: stepRunId,
            workspaceId: row.workspace_id,
            prompt,
            model: selection.id,
            ...(selection.params ? { modelParams: selection.params } : {}),
            cwd: workspace.path,
            access: stepAccess[action.nodeId],
            agentId: keepAgent ? row.agent_id : null,
            onAgent: (agentId) => {
              if (!keepAgent || !dbOpen(this.db)) return;
              this.db.prepare("UPDATE requirements SET agent_id = ? WHERE id = ?").run(agentId, row.id);
            },
            customTools: stepTools((result) => {
              recorded = result;
            }),
          },
          (event) => {
            if (event.type === "text") texts.push(event.text);
            const step = traceFromEvent(event);
            if (step) trace.push(step);
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
              "UPDATE step_runs SET status = ?, result_json = ?, trace_json = ?, ended_at = ? WHERE id = ? AND status = 'running'",
            )
            .run(status, result ? JSON.stringify(result) : null, trace.length ? JSON.stringify(trace) : null, Date.now(), stepRunId);
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

  private begin(row: RequirementRow): { state: DevLoopState | QaState; action: LoopAction | QaAction } {
    if (isQa(row)) return nextQa(initialQaState(), { type: "start" });
    return nextLoop(initialLoopState(1), { type: "start" }, this.cfg);
  }

  private transition(row: RequirementRow, event: LoopEvent): { state: DevLoopState | QaState; action: LoopAction | QaAction } {
    if (!isQa(row)) return nextLoop(this.state(row), event, this.cfg);
    if (event.type === "answer") return nextQa(this.qaState(row), event);
    if (event.type === "abort") return nextQa(this.qaState(row), event);
    return nextQa(this.qaState(row), { type: "answer", text: event.type === "continue" ? event.text : "" });
  }

  private qaState(row: RequirementRow): QaState {
    return row.state_json ? normalizeQaState(JSON.parse(row.state_json)) : initialQaState();
  }

  private save(row: RequirementRow, outcome: { state: DevLoopState | QaState; action: LoopAction | QaAction }, comments?: string): void {
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
      wait = {
        kind: action.waitKind,
        fromStep: action.fromStep,
        message: action.reason,
        comments,
        options: action.options,
        ...(action.questions?.length ? { questions: action.questions } : {}),
      };
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
    return row.state_json ? normalizeLoopState(JSON.parse(row.state_json)) : initialLoopState(1);
  }

  private modelFor(
    step: StepId | "qa",
    workspace: { develop_model: string | null; review_model: string | null },
  ): string {
    return stepModel(step, workspace, { model: this.options.model, reviewModel: this.options.reviewModel });
  }

  private async reviewDiff(workspace: { path: string; repos_json: string }): Promise<string> {
    try {
      return await collectReviewDiff(workspaceRepos(workspace.path, workspace.repos_json));
    } catch (error) {
      return `## 本次改动\n\n收集 diff 失败：${(error as Error).message}`;
    }
  }
}

function isQa(row: { workflow_id?: string }): boolean {
  return row.workflow_id === "cursor-qa";
}

function workspaceRepos(path: string, reposJson: string): string[] {
  try {
    const parsed = JSON.parse(reposJson) as unknown;
    if (Array.isArray(parsed)) {
      const repos = parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
      if (repos.length > 0) return repos;
    }
  } catch {
    // 仓库列表损坏时改为扫描目录。
  }
  return scanGitRepos(path);
}

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { RequirementCard } from "@gateway/shared";
import { dbOpen, transaction } from "../../db.js";
import { appendLog, logFile, readLog } from "../../logs.js";
import { readonlyViolation, watchReadonly } from "../../providers/guard.js";
import type { AgentRuntime, GatewayTool } from "../../runs.js";
import { acceptRequirements } from "./split.js";

export type SplitDraft = { sharedContext: string; cards: RequirementCard[] };

export type SplitTaskRow = {
  id: string;
  workspace_id: string;
  chat_session_id: string | null;
  prompt: string;
  model: string | null;
  agent_id: string | null;
  status: "running" | "draft" | "confirmed" | "failed" | "discarded";
  draft_json: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};

export function splitLogFile(logDir: string, splitId: string): string {
  return `${logDir}/splits/${splitId}.ndjson`;
}

const splitTemplate = `你的任务是把下面的需求拆成若干张可以独立开发、按顺序交付的需求卡。
每张卡要自带完整信息，因为执行阶段的开发 agent 看不到这里的对话：
- title：简短标题
- goal：这张卡要达成什么
- context：背景、已做的决定、约束条件
- acceptanceCriteria：验收标准列表，QA 会逐条检查
- relevantPaths（可选）：相关的文件或目录
- dependsOn（可选）：依赖的前序卡片序号（从 0 开始）
另外写一段 sharedContext，概括整个需求的目标和背景。
可以阅读代码来确认拆分是否合理，但不能修改任何文件。
完成后调用 submit_requirements 工具提交；如果校验失败，按错误提示修正后重新提交。
如果工具不可用，就在回复最后输出一行 <gateway-result>{"sharedContext":"...","cards":[...]}</gateway-result>`;

export class SplitRunner {
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly options: { logDir: string; runtime: () => AgentRuntime | null; model: string },
  ) {}

  start(input: { workspaceId: string; prompt: string; chatSessionId?: string; model?: string }):
    | { ok: true; id: string }
    | { ok: false; code: number; message: string } {
    const runtime = this.options.runtime();
    if (!runtime) return { ok: false, code: 501, message: "当前没有可用的 Cursor agent" };
    const workspace = this.db.prepare("SELECT path, repos_json FROM workspaces WHERE id = ?").get(input.workspaceId) as
      | { path: string; repos_json: string }
      | undefined;
    if (!workspace) return { ok: false, code: 404, message: "workspace 不存在" };
    if (input.chatSessionId) {
      const chat = this.db.prepare("SELECT workspace_id FROM chat_sessions WHERE id = ?").get(input.chatSessionId) as
        | { workspace_id: string }
        | undefined;
      if (!chat || chat.workspace_id !== input.workspaceId) return { ok: false, code: 400, message: "聊天不属于这个 workspace" };
    }
    const id = randomUUID();
    const model = input.model || this.options.model;
    const now = Date.now();
    try {
      this.db
        .prepare(
          `INSERT INTO split_tasks (id, workspace_id, chat_session_id, prompt, model, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`,
        )
        .run(id, input.workspaceId, input.chatSessionId ?? null, input.prompt, model, now, now);
    } catch {
      return { ok: false, code: 409, message: "这个 workspace 已经有一个拆卡在进行中" };
    }

    const file = splitLogFile(this.options.logDir, id);
    const texts: string[] = [];
    const controller = new AbortController();
    const history = input.chatSessionId ? this.transcript(input.chatSessionId) : "";
    const prompt = [splitTemplate, history ? `## 聊天记录（背景）\n${history}` : "", `## 用户的拆卡要求\n${input.prompt}`]
      .filter(Boolean)
      .join("\n\n");
    const done = (async () => {
      const changed = await watchReadonly(JSON.parse(workspace.repos_json) as string[]);
      let failure: string | null = null;
      try {
        const status = await runtime.startRun(
          {
            sessionId: `split:${id}`,
            runId: id,
            workspaceId: input.workspaceId,
            prompt,
            model,
            cwd: workspace.path,
            access: "split",
            agentId: null,
            onAgent: (agentId) => {
              if (dbOpen(this.db)) this.db.prepare("UPDATE split_tasks SET agent_id = ? WHERE id = ?").run(agentId, id);
            },
            customTools: { submit_requirements: this.submitTool(id) },
          },
          (event) => {
            if (event.type === "text") texts.push(event.text);
            appendLog(file, event);
          },
          controller.signal,
        );
        if (status === "cancelled") failure = "已取消";
        else if (status === "error") failure = "拆卡运行失败";
      } catch {
        failure = "拆卡运行失败";
      } finally {
        this.active.delete(id);
      }
      if (await changed()) appendLog(file, { type: "error", message: readonlyViolation });
      if (!dbOpen(this.db)) return;
      const row = this.load(id);
      if (row?.status !== "running") return;
      const fallback = parseDraftBlock(texts);
      if (fallback) {
        this.saveDraft(id, fallback);
        return;
      }
      this.db
        .prepare("UPDATE split_tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
        .run(failure ?? "agent 没有提交需求卡", Date.now(), id);
    })();
    this.active.set(id, { controller, done });
    return { ok: true, id };
  }

  confirm(id: string, draft: unknown, title?: string): { ok: true; featureId: string } | { ok: false; code: number; message: string } {
    const row = this.load(id);
    if (!row) return { ok: false, code: 404, message: "拆卡不存在" };
    if (row.status !== "draft") return { ok: false, code: 409, message: "只有待确认的草稿可以确认" };
    const accepted = acceptRequirements(draft);
    if (!accepted.ok) return { ok: false, code: 400, message: accepted.error };
    const featureId = randomUUID();
    const now = Date.now();
    transaction(this.db, () => {
      this.db
        .prepare(
          "INSERT INTO features (id, workspace_id, split_task_id, title, shared_context, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(featureId, row.workspace_id, id, title?.trim() || featureTitle(row.prompt), accepted.sharedContext, now);
      appendRequirements(this.db, row.workspace_id, featureId, accepted.cards, now);
      this.db
        .prepare("UPDATE split_tasks SET status = 'confirmed', draft_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify({ sharedContext: accepted.sharedContext, cards: accepted.cards }), now, id);
    });
    return { ok: true, featureId };
  }

  discard(id: string): { ok: true } | { ok: false; code: number; message: string } {
    const row = this.load(id);
    if (!row) return { ok: false, code: 404, message: "拆卡不存在" };
    if (row.status === "confirmed") return { ok: false, code: 409, message: "已确认的拆卡不能放弃" };
    this.active.get(id)?.controller.abort();
    this.db.prepare("UPDATE split_tasks SET status = 'discarded', updated_at = ? WHERE id = ?").run(Date.now(), id);
    return { ok: true };
  }

  async stop(): Promise<void> {
    const pending = [...this.active.values()];
    for (const item of pending) item.controller.abort();
    await Promise.allSettled(pending.map((item) => item.done));
  }

  async idle(): Promise<void> {
    await Promise.allSettled([...this.active.values()].map((item) => item.done));
  }

  load(id: string): SplitTaskRow | undefined {
    return this.db.prepare("SELECT * FROM split_tasks WHERE id = ?").get(id) as SplitTaskRow | undefined;
  }

  private submitTool(id: string): GatewayTool {
    return {
      description: "提交拆好的需求卡。参数是 { sharedContext, cards }，cards 的字段见任务说明。",
      inputSchema: {
        type: "object",
        properties: {
          sharedContext: { type: "string" },
          cards: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                goal: { type: "string" },
                context: { type: "string" },
                acceptanceCriteria: { type: "array", items: { type: "string" } },
                relevantPaths: { type: "array", items: { type: "string" } },
                dependsOn: { type: "array", items: { type: "integer" } },
              },
              required: ["title", "goal", "context", "acceptanceCriteria"],
            },
          },
        },
        required: ["sharedContext", "cards"],
      },
      execute: (args) => {
        const accepted = acceptRequirements(args);
        if (!accepted.ok) {
          return { content: [{ type: "text", text: `校验失败：${accepted.error}。请修正后重新调用 submit_requirements。` }], isError: true };
        }
        if (this.load(id)?.status !== "running") return { content: [{ type: "text", text: "这个拆卡已经结束" }], isError: true };
        this.saveDraft(id, { sharedContext: accepted.sharedContext, cards: accepted.cards });
        return `已收到 ${accepted.cards.length} 张需求卡，请结束本轮回复。`;
      },
    };
  }

  private saveDraft(id: string, draft: SplitDraft): void {
    this.db
      .prepare("UPDATE split_tasks SET status = 'draft', draft_json = ?, error = NULL, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(draft), Date.now(), id);
  }

  private transcript(sessionId: string): string {
    const runs = this.db
      .prepare("SELECT id, prompt FROM runs WHERE session_id = ? ORDER BY created_at")
      .all(sessionId) as { id: string; prompt: string | null }[];
    const lines: string[] = [];
    for (const run of runs) {
      if (run.prompt) lines.push(`用户：${run.prompt}`);
      const { events } = readLog(logFile(this.options.logDir, sessionId, run.id), 0);
      const text = events
        .filter((event): event is { type: "text"; text: string } => event.type === "text")
        .map((event) => event.text)
        .join("");
      if (text) lines.push(`助手：${text}`);
    }
    return lines.join("\n\n");
  }
}

export function appendRequirements(
  db: DatabaseSync,
  workspaceId: string,
  featureId: string | null,
  cards: RequirementCard[],
  now = Date.now(),
  workflowId = "cursor-dev-loop",
): string[] {
  const max = db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM requirements WHERE workspace_id = ?").get(workspaceId) as {
    n: number;
  };
  const insert = db.prepare(
    `INSERT INTO requirements (id, workspace_id, feature_id, seq, card_json, status, workflow_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  );
  return cards.map((card, index) => {
    const id = randomUUID();
    insert.run(id, workspaceId, featureId, Number(max.n) + index + 1, JSON.stringify(card), workflowId, now, now);
    return id;
  });
}

function parseDraftBlock(texts: string[]): SplitDraft | null {
  const matches = [...texts.join("\n").matchAll(/<gateway-result>([\s\S]*?)<\/gateway-result>/g)];
  const last = matches.at(-1)?.[1];
  if (!last) return null;
  try {
    const accepted = acceptRequirements(JSON.parse(last));
    return accepted.ok ? { sharedContext: accepted.sharedContext, cards: accepted.cards } : null;
  } catch {
    return null;
  }
}

function featureTitle(prompt: string): string {
  const line = prompt.trim().split(/\r?\n/)[0] ?? "";
  return line.length > 40 ? `${line.slice(0, 40)}…` : line || "未命名需求";
}

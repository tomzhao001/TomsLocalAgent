import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { cursorAccess } from "../src/providers/access.js";
import {
  createCursorRuntime,
  type CursorAgentOptions,
  type CursorSdk,
  type CursorSendOptions,
} from "../src/providers/cursor.js";
import { createOpenCodeRuntime } from "../src/providers/opencode.js";
import { cachedModels, classifyCursorFailure, flattenOpenCodeModels, mapCursorEvent, takeOpencodePart } from "../src/providers/map.js";
import type { AgentRuntime } from "../src/runs.js";

describe("SDK 事件映射", () => {
  it("把 Cursor 的文本、思考、工具和用量写成统一事件", () => {
    expect(
      mapCursorEvent({ type: "assistant", message: { content: [{ type: "text", text: "你好" }] } }),
    ).toEqual([{ type: "text", text: "你好" }]);
    expect(mapCursorEvent({ type: "thinking", text: "想" })).toEqual([{ type: "thinking", text: "想" }]);
    expect(mapCursorEvent({ type: "tool_call", status: "running", call_id: "c1", name: "read" })).toEqual([
      { type: "tool-start", callId: "c1", name: "read" },
    ]);
    expect(mapCursorEvent({ type: "tool_call", status: "running", call_id: "c2", name: "read", args: { path: "src/a.ts" } })).toEqual([
      { type: "tool-start", callId: "c2", name: "read", detail: "src/a.ts" },
    ]);
    expect(mapCursorEvent({ type: "usage", usage: { totalTokens: 3 } })).toEqual([
      { type: "usage", usage: { totalTokens: 3 } },
    ]);
  });

  it("区分 Cursor 没启动和跑失败", () => {
    expect(classifyCursorFailure({ name: "CursorAgentError", message: "401" })).toBe("startup");
    expect(classifyCursorFailure({ status: "error" })).toBe("run");
  });

  it("OpenCode 同一个 part 只落一条", () => {
    const seen = new Set<string>();
    const event = {
      type: "message.part.updated",
      properties: { part: { id: "p1", type: "text", text: "甲", time: { end: 1 } } },
    };
    expect(takeOpencodePart(seen, event)).toEqual({ type: "text", text: "甲" });
    expect(takeOpencodePart(seen, event)).toBeNull();
  });

  it("把 OpenCode provider 摊成 provider/model", () => {
    expect(
      flattenOpenCodeModels({
        providers: [
          { id: "openai", name: "OpenAI", models: { "gpt-4": { name: "GPT-4" }, mini: {} } },
          { name: "opencode", models: { auto: { name: "Auto" } } },
        ],
      }),
    ).toEqual([
      { id: "openai/gpt-4", label: "GPT-4" },
      { id: "openai/mini", label: "openai/mini" },
      { id: "opencode/auto", label: "Auto" },
    ]);
    expect(flattenOpenCodeModels({ data: { providers: [] } })).toEqual([]);
  });

  it("模型列表缓存 10 分钟", async () => {
    let now = 0;
    let calls = 0;
    const load = cachedModels(async () => {
      calls += 1;
      return [{ id: "m", label: "m" }];
    }, 10 * 60 * 1000, () => now);
    await load();
    await load();
    expect(calls).toBe(1);
    now = 10 * 60 * 1000 + 1;
    await load();
    expect(calls).toBe(2);
  });
});

describe("注入的 SDK", () => {
  let app: FastifyInstance;
  let dir: string;

  afterEach(async () => {
    await app?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("换模型只影响这一次 run，取消后状态是 cancelled", async () => {
    const models: string[] = [];
    const cursor = createCursorRuntime(scriptedCursor(models));
    const hanging: AgentRuntime = {
      async startRun(_input, _emit, signal) {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve();
          signal?.addEventListener("abort", () => resolve());
        });
        return "cancelled";
      },
    };
    dir = await mkdtemp(join(tmpdir(), "gw-sdk-"));
    const root = join(dir, "root");
    await mkdir(join(root, "repo"), { recursive: true });
    app = await buildApp({
      dbPath: join(dir, "gateway.db"),
      adminPassword: "correct-horse",
      cookieSecure: true,
      workspaceRoots: [root],
      logDir: join(dir, "logs"),
      runtimes: { cursor, opencode: hanging },
    });
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { password: "correct-horse" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";
    const authed = (method: "GET" | "POST", url: string, payload?: unknown) =>
      app.inject({ method, url, headers: { cookie }, payload });
    const ws = await authed("POST", "/api/workspaces", { name: "代码", path: join(root, "repo") });
    const cursorSession = await authed("POST", "/api/sessions", { provider: "cursor", workspaceId: ws.json().id });
    const first = await authed("POST", `/api/sessions/${cursorSession.json().id}/messages`, { prompt: "一", model: "composer-a" });
    await waitStatus(authed, first.json().runId, "finished");
    const second = await authed("POST", `/api/sessions/${cursorSession.json().id}/messages`, { prompt: "二", model: "composer-b" });
    await waitStatus(authed, second.json().runId, "finished");
    expect(models).toEqual(["composer-a", "composer-b"]);

    const oc = await authed("POST", "/api/sessions", { provider: "opencode", workspaceId: ws.json().id });
    const running = await authed("POST", `/api/sessions/${oc.json().id}/messages`, { prompt: "停", model: "deepseek" });
    const cancelled = await authed("POST", `/api/runs/${running.json().runId}/cancel`);
    expect(cancelled.statusCode).toBe(200);
    await waitStatus(authed, running.json().runId, "cancelled");
  });

  it("聊天档位只读，create 和 resume 都带上 mode 和工具白名单", async () => {
    const calls: { kind: "create" | "resume"; options: CursorAgentOptions; send?: CursorSendOptions }[] = [];
    const runtime = createCursorRuntime(recordingCursor(calls));
    const saved: string[] = [];
    const base = { sessionId: "s", runId: "r", workspaceId: "w", prompt: "看看", model: "m", cwd: "/" };
    await runtime.startRun({ ...base, access: "chat", agentId: null, onAgent: (id) => saved.push(id) }, () => {});
    await runtime.startRun({ ...base, access: "chat", agentId: "agent-1", onAgent: (id) => saved.push(id) }, () => {});
    expect(calls.map((call) => call.kind)).toEqual(["create", "resume"]);
    expect(saved).toEqual(["agent-1"]);
    for (const call of calls) {
      expect(call.options.access.mode).toBe("plan");
      expect(call.options.access.tools).toBeDefined();
      for (const banned of ["edit", "delete", "shell", "applyAgentDiff", "task", "mcp"]) {
        expect(call.options.access.tools).not.toContain(banned);
      }
    }
  });

  it("工作流各步骤用各自的档位，拆卡和审核不能编辑", () => {
    expect(cursorAccess.develop.tools).toBeUndefined();
    for (const profile of ["split", "plan", "review", "qa", "devops"] as const) {
      expect(cursorAccess[profile].tools).toContain("mcp");
      expect(cursorAccess[profile].tools).not.toContain("edit");
      expect(cursorAccess[profile].tools).not.toContain("delete");
    }
    expect(cursorAccess.plan.mode).toBe("plan");
    expect(cursorAccess.develop.mode).toBe("agent");
    expect(cursorAccess.split.tools).not.toContain("shell");
    expect(cursorAccess.plan.tools).not.toContain("shell");
    expect(cursorAccess.review.tools).not.toContain("shell");
    expect(cursorAccess.qa.tools).toContain("shell");
    expect(cursorAccess.devops.tools).toContain("shell");
  });

  it("OpenCode 拒绝非聊天的运行", async () => {
    const runtime = createOpenCodeRuntime({
      models: [],
      prompt: async () => {},
      abort: async () => {},
      ensureSession: async () => "oc",
      events: async function* () {},
    });
    const events: { type: string }[] = [];
    const status = await runtime.startRun(
      { sessionId: "s", runId: "r", workspaceId: "w", prompt: "改代码", model: "m", cwd: "/", access: "develop" },
      (event) => events.push(event),
    );
    expect(status).toBe("error");
    expect(events[0]).toMatchObject({ type: "error" });
  });

  it("OpenCode 运行时对重复 part 只发出一条", async () => {
    const part = { id: "p1", type: "text", text: "只一次", sessionID: "oc", time: { end: 1 } };
    const runtime = createOpenCodeRuntime({
      models: [],
      prompt: async () => {},
      abort: async () => {},
      ensureSession: async () => "oc",
      events: async function* () {
        yield { type: "message.part.updated", properties: { part } };
        yield { type: "message.part.updated", properties: { part } };
        yield { type: "session.idle" };
      },
    });
    const events: { type: string; text?: string }[] = [];
    const status = await runtime.startRun(
      { sessionId: "s", runId: "r", workspaceId: "w", prompt: "hi", model: "m", cwd: "/" },
      (event) => events.push(event),
    );
    expect(status).toBe("finished");
    expect(events.filter((event) => event.type === "text")).toEqual([{ type: "text", text: "只一次" }]);
  });
});

function scriptedCursor(models: string[]): CursorSdk {
  return {
    models: [{ id: "composer-a", label: "A" }],
    async create() {
      return agent();
    },
    async resume() {
      return agent();
    },
  };

  function agent() {
    return {
      agentId: "agent-1",
      async send(prompt: string, options: CursorSendOptions) {
        models.push(options.model.id);
        return {
          async *stream() {
            yield { type: "assistant", message: { content: [{ type: "text", text: prompt }] } };
          },
          async wait() {
            return { status: "finished" as const };
          },
          async cancel() {},
        };
      },
    };
  }
}

function recordingCursor(calls: { kind: "create" | "resume"; options: CursorAgentOptions; send?: CursorSendOptions }[]): CursorSdk {
  const agent = (entry: { send?: CursorSendOptions }) => ({
    agentId: "agent-1",
    async send(_prompt: string, options: CursorSendOptions) {
      entry.send = options;
      return {
        async *stream() {},
        async wait() {
          return { status: "finished" as const };
        },
        async cancel() {},
      };
    },
  });
  return {
    models: [],
    async create(options) {
      const entry = { kind: "create" as const, options };
      calls.push(entry);
      return agent(entry);
    },
    async resume(_agentId, options) {
      const entry = { kind: "resume" as const, options };
      calls.push(entry);
      return agent(entry);
    },
  };
}

async function waitStatus(
  authed: (method: "GET" | "POST", url: string, payload?: unknown) => Promise<{ json: () => unknown }>,
  runId: string,
  status: string,
) {
  for (let i = 0; i < 40; i++) {
    const body = (await (await authed("GET", `/api/runs/${runId}/log?offset=0`)).json()) as { status: string };
    if (body.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`status did not become ${status}`);
}

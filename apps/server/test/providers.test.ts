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
import { cachedModels, classifyCursorFailure, flattenOpenCodeModels, formatVariantId, mapCursorEvent, mapCursorModels, matchVariant, parseVariantId, resolveStoredModel, takeOpencodePart } from "../src/providers/map.js";
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

  it("Cursor 模型保留参数和默认组合", () => {
    expect(
      mapCursorModels([
        {
          id: "composer-2.5",
          displayName: "Composer 2.5",
          parameters: [
            { id: "effort", displayName: "effort", values: [{ value: "low" }, { value: "high", displayName: "high" }] },
            { id: "fast", displayName: "Fast", values: [{ value: "true", displayName: "Fast" }] },
          ],
          variants: [
            { displayName: "默认", isDefault: true, params: [{ id: "effort", value: "high" }, { id: "fast", value: "true" }] },
            { params: [{ id: "skip", value: "" }] },
          ],
        },
        { name: "只有名字" },
        { id: "auto", name: "Auto" },
      ]),
    ).toEqual([
      {
        id: "composer-2.5",
        label: "Composer 2.5",
        parameters: [
          { id: "effort", label: "effort", values: [{ value: "low", label: "low" }, { value: "high", label: "high" }] },
          { id: "fast", label: "Fast", values: [{ value: "true", label: "Fast" }] },
        ],
        variants: [{ label: "默认", isDefault: true, params: [{ id: "effort", value: "high" }, { id: "fast", value: "true" }] }],
      },
      { id: "auto", label: "Auto" },
    ]);
    expect(mapCursorModels(null)).toEqual([]);
  });

  it("变体字符串和裸 id 都能回到真实组合", () => {
    const model = {
      id: "grok-4.7",
      label: "Grok 4.7",
      parameters: [
        { id: "context", label: "上下文", values: [{ value: "256k", label: "256k" }, { value: "500k", label: "500k" }] },
        { id: "reasoning_effort", label: "推理", values: [{ value: "low", label: "low" }, { value: "high", label: "high" }] },
        { id: "fast", label: "fast", values: [{ value: "false", label: "标准" }, { value: "true", label: "Fast" }] },
      ],
      variants: [
        {
          label: "默认",
          isDefault: true,
          params: [
            { id: "context", value: "500k" },
            { id: "reasoning_effort", value: "high" },
            { id: "fast", value: "true" },
          ],
        },
        {
          label: "短",
          params: [
            { id: "context", value: "256k" },
            { id: "reasoning_effort", value: "low" },
            { id: "fast", value: "false" },
          ],
        },
      ],
    };
    expect(formatVariantId("grok-4.7", model.variants[0]!.params)).toBe("grok-4.7[context=500k,reasoning_effort=high,fast=true]");
    expect(parseVariantId("grok-4.7")).toEqual({ id: "grok-4.7", params: [] });
    expect(resolveStoredModel([model], "grok-4.7")).toEqual({
      id: "grok-4.7",
      params: model.variants[0]!.params,
    });
    expect(matchVariant(model, model.variants[0]!.params, { id: "context", value: "256k" })).toEqual(model.variants[1]!.params);
    expect(resolveStoredModel([], "grok-4.7[context=256k,reasoning_effort=low,fast=false]")).toEqual({
      id: "grok-4.7",
      params: model.variants[1]!.params,
    });
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
    const models: { id: string; params?: { id: string; value: string }[] }[] = [];
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
    const second = await authed("POST", `/api/sessions/${cursorSession.json().id}/messages`, {
      prompt: "二",
      model: "composer-b",
      params: [{ id: "effort", value: "high" }, { id: "", value: "x" }, { value: "low" }],
    });
    await waitStatus(authed, second.json().runId, "finished");
    expect(models).toEqual([{ id: "composer-a" }, { id: "composer-b", params: [{ id: "effort", value: "high" }] }]);

    const oc = await authed("POST", "/api/sessions", { provider: "opencode", workspaceId: ws.json().id });
    const running = await authed("POST", `/api/sessions/${oc.json().id}/messages`, { prompt: "停", model: "deepseek" });
    const cancelled = await authed("POST", `/api/runs/${running.json().runId}/cancel`);
    expect(cancelled.statusCode).toBe(200);
    await waitStatus(authed, running.json().runId, "cancelled");
  });

  it("聊天档位只读，create 和 resume 都带上 mode 和工具白名单", async () => {
    const calls: { kind: "create" | "resume"; options: CursorAgentOptions; send?: CursorSendOptions; prompt?: string }[] = [];
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
      expect(call.prompt).toContain("只读");
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

  it("聊天模式随每条消息切换，Agent 不加只读纪律", async () => {
    const calls: { kind: "create" | "resume"; options: CursorAgentOptions; send?: CursorSendOptions; prompt?: string }[] = [];
    const runtime = createCursorRuntime(recordingCursor(calls));
    const base = { sessionId: "s", runId: "r", workspaceId: "w", prompt: "看看", model: "m", cwd: "/", access: "chat" as const };
    await runtime.startRun({ ...base, chatMode: "plan", agentId: null }, () => {});
    await runtime.startRun({ ...base, chatMode: "ask", agentId: "agent-1" }, () => {});
    await runtime.startRun({ ...base, chatMode: "agent", agentId: "agent-1" }, () => {});
    expect(calls.map((call) => call.kind)).toEqual(["create", "resume", "resume"]);
    expect(calls[0]?.options.access.mode).toBe("plan");
    expect(calls[0]?.options.access.tools).toEqual(expect.arrayContaining(["read"]));
    expect(calls[0]?.options.access.tools).not.toContain("shell");
    expect(calls[0]?.send?.mode).toBe("plan");
    expect(calls[0]?.prompt).toBe("看看");
    expect(calls[1]?.options.access).toMatchObject({ mode: "plan" });
    expect(calls[1]?.options.access.tools).not.toContain("shell");
    expect(calls[1]?.prompt).toBe("看看");
    expect(calls[2]?.options.access).toEqual({ mode: "agent", rules: "" });
    expect(calls[2]?.send?.mode).toBe("agent");
    expect(calls[2]?.prompt).toBe("看看");
    expect(calls[2]?.send?.model).toEqual({ id: "m" });
  });

  it("本次发送把模型参数交给 create 和 send", async () => {
    const calls: { kind: "create" | "resume"; options: CursorAgentOptions; send?: CursorSendOptions; prompt?: string }[] = [];
    const runtime = createCursorRuntime(recordingCursor(calls));
    const params = [{ id: "effort", value: "high" }, { id: "fast", value: "true" }];
    const base = { sessionId: "s", runId: "r", workspaceId: "w", prompt: "看看", model: "m", cwd: "/", access: "develop" as const };
    await runtime.startRun({ ...base, modelParams: params, agentId: null }, () => {});
    expect(calls[0]?.options.modelParams).toEqual(params);
    expect(calls[0]?.send?.model).toEqual({ id: "m", params });
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

function scriptedCursor(models: { id: string; params?: { id: string; value: string }[] }[]): CursorSdk {
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
        models.push(options.model);
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

function recordingCursor(
  calls: { kind: "create" | "resume"; options: CursorAgentOptions; send?: CursorSendOptions; prompt?: string }[],
): CursorSdk {
  const agent = (entry: { send?: CursorSendOptions; prompt?: string }) => ({
    agentId: "agent-1",
    async send(prompt: string, options: CursorSendOptions) {
      entry.send = options;
      entry.prompt = prompt;
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

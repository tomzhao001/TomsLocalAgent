import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GatewayEvent } from "@gateway/shared";
import { acpErrorText, acpInitializeParams, agentCandidates, createAcpRuntime, permissionChoice, routeCursorRuntime, type AcpIncoming, type AcpLink } from "../src/providers/acp.js";
import { mergeTodos } from "../src/providers/plan-doc.js";
import type { AgentRuntime } from "../src/runs.js";
const session = {
  sessionId: "sess-1",
  modes: { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }, { id: "plan", name: "Plan" }] },
  configOptions: [{ id: "model", category: "model", currentValue: "auto" }],
};

describe("ACP 计划与权限", () => {
  it("合并待办时按 id 更新，不合并时整表替换", () => {
    const current = [
      { id: "t1", content: "改表单", status: "pending" as const },
      { id: "t2", content: "补测试", status: "pending" as const },
    ];
    expect(mergeTodos(current, [{ id: "t1", content: "改表单", status: "completed" }], true)).toEqual([
      { id: "t1", content: "改表单", status: "completed" },
      { id: "t2", content: "补测试", status: "pending" },
    ]);
    expect(mergeTodos(current, [{ id: "t3", content: "只留这个", status: "pending" }], false)).toEqual([
      { id: "t3", content: "只留这个", status: "pending" },
    ]);
  });

  it("写操作拒绝，读操作允许一次", () => {
    const options = [
      { optionId: "allow-once", kind: "allow_once" },
      { optionId: "reject-once", kind: "reject_once" },
    ];
    expect(permissionChoice({ kind: "execute", title: "shell" }, options)).toBe("reject-once");
    expect(permissionChoice({ kind: "execute", title: "shell" }, options, true)).toBe("allow-once");
    expect(permissionChoice({ kind: "read", rawInput: { path: "src/a.ts" } }, options)).toBe("allow-once");
  });

  it("出计划、更新待办、提问和工具都进事件，同一会话用 load 续上", async () => {
    const link = scripted((method, params, peer) => {
      if (method === "session/new" || method === "session/load") return session;
      if (method === "session/prompt") {
        peer.emit({
          method: "session/update",
          params: {
            sessionId: "sess-1",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "先看代码" } },
          },
        });
        peer.emit({
          method: "session/update",
          params: {
            sessionId: "sess-1",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "call-1",
              name: "read",
              status: "completed",
              rawInput: { path: "src/a.ts" },
            },
          },
        });
        peer.emit({
          id: 11,
          method: "cursor/create_plan",
          params: {
            name: "登录",
            overview: "收紧登录",
            plan: "1. 改表单",
            todos: [{ id: "t1", content: "改表单", status: "pending" }],
          },
        });
        peer.emit({
          id: 12,
          method: "cursor/update_todos",
          params: { merge: true, todos: [{ id: "t1", content: "改表单", status: "completed" }, { id: "t2", content: "补测试", status: "pending" }] },
        });
        peer.emit({
          id: 13,
          method: "cursor/ask_question",
          params: { questions: [{ id: "q1", prompt: "用 SQLite 还是 JSON？" }] },
        });
        peer.emit({
          id: 14,
          method: "session/request_permission",
          params: {
            sessionId: "sess-1",
            toolCall: { kind: "execute", title: "shell" },
            options: [
              { optionId: "allow-once", kind: "allow_once" },
              { optionId: "reject-once", kind: "reject_once" },
            ],
          },
        });
        return { stopReason: "end_turn" };
      }
      return {};
    });
    const saved: string[] = [];
    const runtime = createAcpRuntime(async () => link);
    const base = { sessionId: "s", runId: "r", workspaceId: "w", prompt: "做计划", model: "composer", cwd: "/work", access: "chat" as const };
    const first = await collect(runtime, { ...base, chatMode: "plan", agentId: null, onAgent: (id) => saved.push(id) });
    expect(first.status).toBe("finished");
    expect(saved).toEqual(["sess-1"]);
    expect(link.calls.map((call) => call.method)).toEqual([
      "session/new",
      "session/set_mode",
      "session/set_config_option",
      "session/prompt",
    ]);
    expect(link.calls[1]?.params).toMatchObject({ modeId: "plan" });
    expect(link.calls[2]?.params).toMatchObject({ configId: "model", value: "composer" });
    expect(first.events.map((event) => event.type)).toEqual(["text", "tool-start", "tool-end", "plan", "todos", "text"]);
    expect(first.events[2]).toMatchObject({ type: "tool-end", name: "read", detail: "src/a.ts" });
    expect(first.events[3]).toMatchObject({ type: "plan", plan: { plan: "1. 改表单" } });
    expect(first.events[4]).toMatchObject({
      type: "todos",
      todos: [
        { id: "t1", status: "completed" },
        { id: "t2", content: "补测试" },
      ],
    });
    expect(first.events[5]).toMatchObject({ type: "text", text: expect.stringContaining("用 SQLite 还是 JSON？") });
    expect(link.replies).toEqual([
      { id: 11, result: { outcome: { outcome: "accepted" } } },
      {
        id: 12,
        result: {
          outcome: {
            outcome: "accepted",
            todos: [
              { id: "t1", content: "改表单", status: "completed" },
              { id: "t2", content: "补测试", status: "pending" },
            ],
          },
        },
      },
      { id: 13, result: { outcome: { outcome: "skipped", reason: "请在下一条消息里回答" } } },
      { id: 14, result: { outcome: { outcome: "selected", optionId: "reject-once" } } },
    ]);

    link.calls.length = 0;
    const second = await collect(runtime, { ...base, chatMode: "ask", agentId: "sess-1" });
    expect(second.status).toBe("finished");
    expect(link.calls[0]?.method).toBe("session/load");
    expect(link.calls[1]?.params).toMatchObject({ modeId: "ask" });
  });

  it("消息片段到达就发出，不等到回合结束", async () => {
    const link = scripted((method, _params, peer) => {
      if (method === "session/new") return session;
      if (method === "session/prompt") {
        peer.emit({
          method: "session/update",
          params: { sessionId: "sess-1", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "想" } } },
        });
        peer.emit({
          method: "session/update",
          params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "你" } } },
        });
        peer.emit({
          method: "session/update",
          params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "好" } } },
        });
        return { stopReason: "end_turn" };
      }
      return {};
    });
    const runtime = createAcpRuntime(async () => link);
    const result = await collect(runtime, {
      sessionId: "s",
      runId: "r",
      workspaceId: "w",
      prompt: "你好",
      model: "auto",
      cwd: "/",
      access: "chat",
      chatMode: "ask",
    });
    expect(result.events).toEqual([
      { type: "thinking", text: "想" },
      { type: "text", text: "你" },
      { type: "text", text: "好" },
    ]);
  });

  it("Agent 模式切换到 agent，并允许写入", async () => {
    const agentSession = {
      ...session,
      modes: {
        currentModeId: "agent",
        availableModes: [
          { id: "agent", name: "Agent" },
          { id: "ask", name: "Ask" },
          { id: "plan", name: "Plan" },
        ],
      },
    };
    const link = scripted((method, _params, peer) => {
      if (method === "session/new") return agentSession;
      if (method === "session/prompt") {
        peer.emit({
          id: 9,
          method: "session/request_permission",
          params: {
            sessionId: "sess-1",
            toolCall: { kind: "edit", title: "write" },
            options: [
              { optionId: "allow-once", kind: "allow_once" },
              { optionId: "reject-once", kind: "reject_once" },
            ],
          },
        });
        return { stopReason: "end_turn" };
      }
      return {};
    });
    const runtime = createAcpRuntime(async () => link);
    const result = await collect(runtime, {
      sessionId: "s",
      runId: "r",
      workspaceId: "w",
      prompt: "改一下",
      model: "auto",
      cwd: "/",
      access: "chat",
      chatMode: "agent",
    });
    expect(result.status).toBe("finished");
    expect(link.calls[1]?.params).toMatchObject({ modeId: "agent" });
    expect(link.replies[0]).toEqual({ id: 9, result: { outcome: { outcome: "selected", optionId: "allow-once" } } });
  });

  it("同一会话从 Plan 切到 Agent 时放行写入", async () => {
    const both = {
      ...session,
      modes: {
        currentModeId: "plan",
        availableModes: [
          { id: "agent", name: "Agent" },
          { id: "ask", name: "Ask" },
          { id: "plan", name: "Plan" },
        ],
      },
    };
    const link = scripted((method, _params, peer) => {
      if (method === "session/new" || method === "session/load") return both;
      if (method === "session/prompt") {
        peer.emit({
          id: 9,
          method: "session/request_permission",
          params: {
            sessionId: "sess-1",
            toolCall: { kind: "execute", title: "shell" },
            options: [
              { optionId: "allow-once", kind: "allow_once" },
              { optionId: "reject-once", kind: "reject_once" },
            ],
          },
        });
        return { stopReason: "end_turn" };
      }
      return {};
    });
    const runtime = createAcpRuntime(async () => link);
    const base = { sessionId: "s", runId: "r", workspaceId: "w", prompt: "改一下", model: "auto", cwd: "/", access: "chat" as const };
    const first = await collect(runtime, { ...base, chatMode: "plan", agentId: null });
    expect(first.status).toBe("finished");
    expect(link.calls.find((call) => call.method === "session/set_mode")?.params).toMatchObject({ modeId: "plan" });
    expect(link.replies[0]).toEqual({ id: 9, result: { outcome: { outcome: "selected", optionId: "reject-once" } } });
    link.calls.length = 0;
    link.replies.length = 0;
    const second = await collect(runtime, { ...base, chatMode: "agent", agentId: "sess-1" });
    expect(second.status).toBe("finished");
    expect(link.calls[0]?.method).toBe("session/load");
    expect(link.calls.find((call) => call.method === "session/set_mode")?.params).toMatchObject({ modeId: "agent" });
    expect(link.replies[0]).toEqual({ id: 9, result: { outcome: { outcome: "selected", optionId: "allow-once" } } });
  });

  it("加载旧会话失败时新建 ACP 会话", async () => {
    const link = scripted((method) => {
      if (method === "session/load") throw new Error("会话不存在");
      if (method === "session/new") return session;
      return {};
    });
    const runtime = createAcpRuntime(async () => link);
    const saved: string[] = [];
    const result = await collect(runtime, {
      sessionId: "s",
      runId: "r",
      workspaceId: "w",
      prompt: "继续",
      model: "auto",
      cwd: "/",
      access: "chat",
      chatMode: "ask",
      agentId: "agent-old",
      onAgent: (id) => saved.push(id),
    });
    expect(result.status).toBe("finished");
    expect(link.calls.map((call) => call.method).slice(0, 2)).toEqual(["session/load", "session/new"]);
    expect(saved).toEqual(["sess-1"]);
  });

  it("按系统查找 agent 可执行文件", () => {
    expect(agentCandidates("win32", { LOCALAPPDATA: "C:\\Users\\tom\\AppData\\Local" }, "C:\\Users\\tom")).toEqual([
      "agent",
      join("C:\\Users\\tom\\AppData\\Local", "cursor-agent", "agent.cmd"),
    ]);
    expect(agentCandidates("darwin", {}, "/Users/tom")).toEqual(["agent", join("/Users/tom", ".local", "bin", "agent")]);
    expect(agentCandidates("darwin", { CURSOR_AGENT_BIN: "/opt/agent" }, "/Users/tom")[0]).toBe("/opt/agent");
  });

  it("没有模式声明时直接报错，不调用 set_mode", async () => {
    const link = scripted((method) => {
      if (method === "session/new") return { sessionId: "sess-2" };
      return {};
    });
    const runtime = createAcpRuntime(async () => link);
    const result = await collect(runtime, {
      sessionId: "s",
      runId: "r",
      workspaceId: "w",
      prompt: "看看",
      model: "m",
      cwd: "/",
      access: "chat",
      chatMode: "ask",
    });
    expect(result.status).toBe("error");
    expect(result.events[0]).toMatchObject({ type: "error", message: "ACP 没有声明模式切换" });
    expect(link.calls.map((call) => call.method)).toEqual(["session/new"]);
  });

  it("初始化声明参数化模型选择，拒绝原因带上 data.message", () => {
    expect(acpInitializeParams.clientCapabilities._meta.parameterizedModelPicker).toBe(true);
    expect(acpErrorText({ message: "Invalid params", data: { message: "Invalid model value: grok-4.7" } })).toBe(
      "Invalid params：Invalid model value: grok-4.7",
    );
  });

  it("模型参数用切换后的配置项，已经相同或没有的项跳过", async () => {
    const configured = {
      ...session,
      modes: {
        currentModeId: "agent",
        availableModes: [
          { id: "agent", name: "Agent" },
          { id: "ask", name: "Ask" },
        ],
      },
      configOptions: [
        { id: "model", category: "model", currentValue: "auto" },
        { id: "temperature", currentValue: "0" },
      ],
    };
    const link = scripted((method, params) => {
      if (method === "session/new") return configured;
      if (method === "session/set_config_option" && (params as { configId?: string }).configId === "model") {
        return {
          configOptions: [
            { id: "model", category: "model", currentValue: "composer" },
            { id: "effort", currentValue: "low" },
            { id: "fast", currentValue: "true" },
          ],
        };
      }
      return {};
    });
    const runtime = createAcpRuntime(async () => link);
    const result = await collect(runtime, {
      sessionId: "s",
      runId: "r",
      workspaceId: "w",
      prompt: "看看",
      model: "composer",
      modelParams: [
        { id: "temperature", value: "1" },
        { id: "effort", value: "high" },
        { id: "fast", value: "true" },
        { id: "context", value: "1m" },
      ],
      cwd: "/",
      access: "chat",
      chatMode: "agent",
    });
    expect(result.status).toBe("finished");
    expect(link.calls.map((call) => call.method)).toEqual([
      "session/new",
      "session/set_mode",
      "session/set_config_option",
      "session/set_config_option",
      "session/prompt",
    ]);
    expect(link.calls[2]?.params).toMatchObject({ configId: "model", value: "composer" });
    expect(link.calls[3]?.params).toMatchObject({ configId: "effort", value: "high" });
  });

  it("聊天走 ACP，工作流仍走 SDK", async () => {
    const seen: string[] = [];
    const runtime = routeCursorRuntime(mark("sdk", seen), mark("acp", seen));
    await runtime.startRun(ctx("chat"), () => {});
    await runtime.startRun(ctx("develop"), () => {});
    expect(seen).toEqual(["acp", "sdk"]);
  });
});

function mark(name: string, seen: string[]): AgentRuntime {
  return {
    async startRun() {
      seen.push(name);
      return "finished";
    },
  };
}

function ctx(access: "chat" | "develop") {
  return { sessionId: "s", runId: "r", workspaceId: "w", prompt: "hi", model: "m", cwd: "/", access };
}

async function collect(runtime: AgentRuntime, input: Parameters<AgentRuntime["startRun"]>[0]) {
  const events: GatewayEvent[] = [];
  const status = await runtime.startRun(input, (event) => events.push(event));
  return { status, events };
}

function scripted(onRequest: (method: string, params: unknown, link: ScriptedLink) => unknown): ScriptedLink {
  return new ScriptedLink(onRequest);
}

class ScriptedLink implements AcpLink {
  readonly calls: { method: string; params: unknown }[] = [];
  readonly replies: { id: number | string; result?: unknown; error?: string }[] = [];
  private readonly listeners = new Set<(message: AcpIncoming) => void>();

  constructor(private readonly onRequest: (method: string, params: unknown, link: ScriptedLink) => unknown) {}

  async request(method: string, params: unknown) {
    this.calls.push({ method, params });
    return this.onRequest(method, params, this);
  }

  notify(method: string, params: unknown) {
    this.calls.push({ method, params });
  }

  respond(id: number | string, result: unknown) {
    this.replies.push({ id, result });
  }

  reject(id: number | string, message: string) {
    this.replies.push({ id, error: message });
  }

  subscribe(listener: (message: AcpIncoming) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(message: AcpIncoming) {
    for (const listener of this.listeners) listener(message);
  }

  close() {}
}

import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { GatewayEvent, PlanDocument } from "@gateway/shared";
import type { AgentRuntime, RunContext, RunTerminal } from "../runs.js";
import { toolDetail } from "./map.js";
import { mergeTodos, planFromCreate, questionText, todosFromUpdate } from "./plan-doc.js";

export type AcpIncoming = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
};

export type AcpLink = {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
  respond(id: number | string, result: unknown): void;
  reject(id: number | string, message: string): void;
  subscribe(listener: (message: AcpIncoming) => void): () => void;
  close(): void;
};

type PermissionOption = { optionId?: string; kind?: string };
type ToolShape = { kind?: string; name?: string; title?: string; rawInput?: unknown };

const writeKinds = new Set(["edit", "delete", "move", "execute", "switch_mode"]);
const writeName = /shell|bash|write|edit|delete|apply|terminal|command/i;

export function permissionChoice(tool: ToolShape, options: PermissionOption[], allowWrite = false): string | null {
  const blocked = isWrite(tool) && !allowWrite;
  const want = blocked ? "reject_once" : "allow_once";
  const fallback = blocked ? "reject_always" : "allow_always";
  const match =
    options.find((option) => sameKind(option.kind, want) || sameKind(option.optionId, want)) ??
    options.find((option) => sameKind(option.kind, fallback) || sameKind(option.optionId, fallback));
  return match?.optionId ?? null;
}

export function createAcpRuntime(open: () => Promise<AcpLink>): AgentRuntime & { close(): void } {
  let link: AcpLink | null = null;
  let opening: Promise<AcpLink> | null = null;
  let generation = 0;
  let queue: Promise<unknown> = Promise.resolve();

  function drop() {
    generation += 1;
    link?.close();
    link = null;
    opening = null;
  }

  async function connection(): Promise<AcpLink> {
    if (link) return link;
    const ticket = generation;
    opening ??= open()
      .then((created) => {
        if (ticket !== generation) {
          created.close();
          throw new Error("ACP 进程已退出");
        }
        link = created;
        return created;
      })
      .catch((error) => {
        if (ticket === generation) opening = null;
        throw error;
      });
    return opening;
  }

  const runtime: AgentRuntime & { close(): void } = {
    close() {
      drop();
    },
    async startRun(input, emit, signal) {
      const run = queue.then(() => runTurn(connection, drop, input, emit, signal));
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
  return runtime;
}

const probeTimeoutMs = 15_000;

export function agentCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string[] {
  const found: string[] = [];
  const push = (value?: string) => {
    const trimmed = value?.trim();
    if (trimmed && !found.includes(trimmed)) found.push(trimmed);
  };
  push(env.CURSOR_AGENT_BIN);
  push("agent");
  if (platform === "win32") {
    push(join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "cursor-agent", "agent.cmd"));
  } else {
    push(join(home, ".local", "bin", "agent"));
  }
  return found;
}

export async function openCursorAcp(options: {
  apiKey: string;
  bins?: string[];
}): Promise<{ runtime: AgentRuntime; close: () => void } | null> {
  const bins = options.bins ?? agentCandidates();
  const reasons: string[] = [];
  for (const bin of bins) {
    const probed = await probeAgent(bin);
    if (probed.ok) {
      console.log(`Cursor ACP 已接上：${bin}`);
      const runtime = createAcpRuntime(() => spawnAcpLink(bin, options.apiKey));
      return { runtime, close: () => runtime.close() };
    }
    reasons.push(`${bin}：${probed.reason}`);
  }
  console.error(`Cursor ACP 不可用，聊天回退 SDK。${reasons.join("；")}`);
  return null;
}

export function routeCursorRuntime(workflow: AgentRuntime, chat: AgentRuntime | null): AgentRuntime {
  if (!chat) return workflow;
  return {
    listModels: workflow.listModels?.bind(workflow),
    startRun(input, emit, signal) {
      const selected = (input.access ?? "chat") === "chat" ? chat : workflow;
      return selected.startRun(input, emit, signal);
    },
  };
}

export function probeAgent(bin: string, timeoutMs = probeTimeoutMs): Promise<{ ok: true } | { ok: false; reason: string }> {
  return new Promise((resolveProbe) => {
    let settled = false;
    const finish = (result: { ok: true } | { ok: false; reason: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProbe(result);
    };
    let child: ChildProcess;
    try {
      child = spawnAgent(bin, ["--version"], "ignore");
    } catch (error) {
      resolveProbe({ ok: false, reason: error instanceof Error ? error.message : "无法启动" });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, reason: "探测超时" });
    }, timeoutMs);
    child.on("error", (error) => finish({ ok: false, reason: error.message }));
    child.on("exit", (code) => finish(code === 0 ? { ok: true } : { ok: false, reason: `退出码 ${code ?? "无"}` }));
  });
}

function spawnAgent(bin: string, args: string[], stdio: "ignore" | ["pipe", "pipe", "pipe"], env?: NodeJS.ProcessEnv) {
  return spawn(bin, args, {
    windowsHide: true,
    shell: process.platform === "win32",
    stdio,
    env,
  });
}

async function spawnAcpLink(bin: string, apiKey: string): Promise<AcpLink> {
  const child = spawnAgent(bin, ["--api-key", apiKey, "acp"], ["pipe", "pipe", "pipe"], {
    ...process.env,
    CURSOR_API_KEY: apiKey,
  }) as ChildProcessWithoutNullStreams;
  const link = new ProcessLink(child);
  await link.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "toms-gateway", version: "0.0.1" },
  });
  await link.request("authenticate", { methodId: "cursor_login" });
  return link;
}

async function runTurn(
  connection: () => Promise<AcpLink>,
  drop: () => void,
  input: RunContext,
  emit: (event: GatewayEvent) => void,
  signal?: AbortSignal,
): Promise<RunTerminal> {
  let current: AcpLink;
  try {
    current = await connection();
  } catch (error) {
    emit({ type: "error", message: error instanceof Error ? error.message : "ACP 启动失败" });
    return "error";
  }

  const mode = input.chatMode === "plan" ? "plan" : input.chatMode === "agent" ? "agent" : "ask";
  const allowWrite = mode === "agent";
  const cwd = resolve(input.cwd);
  let sessionId = "";
  let plan: PlanDocument | null = null;
  const started = new Set<string>();

  const unsubscribe = current.subscribe((message) => {
    if (!message.method) return;
    if (message.method === "session/update") {
      const params = asRecord(message.params);
      if (params.sessionId !== sessionId) return;
      handleUpdate(params.update);
      return;
    }
    if (message.id === undefined) return;
    if (message.method === "session/request_permission") {
      const params = asRecord(message.params);
      if (params.sessionId && params.sessionId !== sessionId) return;
      const tool = asRecord(params.toolCall);
      const options = Array.isArray(params.options) ? (params.options as PermissionOption[]) : [];
      const optionId = permissionChoice(
        { kind: stringOf(tool.kind), name: stringOf(tool.name) ?? stringOf(tool.title), title: stringOf(tool.title), rawInput: tool.rawInput },
        options,
        allowWrite,
      );
      current.respond(message.id, { outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } });
      return;
    }
    if (message.method === "cursor/create_plan") {
      const created = planFromCreate(message.params);
      if (!created) {
        current.respond(message.id, { outcome: { outcome: "rejected", reason: "计划正文为空" } });
        return;
      }
      plan = created;
      emit({ type: "plan", plan: created });
      current.respond(message.id, { outcome: { outcome: "accepted" } });
      return;
    }
    if (message.method === "cursor/update_todos") {
      const update = todosFromUpdate(message.params);
      if (!update) {
        current.respond(message.id, { outcome: { outcome: "rejected", reason: "待办格式不对" } });
        return;
      }
      const todos = mergeTodos(plan?.todos ?? [], update.todos, update.merge);
      plan = { ...(plan ?? { plan: "", todos: [] }), todos };
      emit({ type: "todos", todos });
      current.respond(message.id, { outcome: { outcome: "accepted", todos } });
      return;
    }
    if (message.method === "cursor/ask_question") {
      emit({ type: "text", text: questionText(message.params) });
      current.respond(message.id, { outcome: { outcome: "skipped", reason: "请在下一条消息里回答" } });
      return;
    }
    if (message.method === "cursor/task" || message.method === "cursor/generate_image") {
      const params = asRecord(message.params);
      const name = message.method === "cursor/task" ? "task" : "generate_image";
      const detail = stringOf(params.description);
      const callId = stringOf(params.toolCallId) ?? name;
      emit({ type: "tool-start", callId, name, ...(detail ? { detail } : {}) });
      emit({ type: "tool-end", callId, name, ...(detail ? { detail } : {}) });
      if (message.method === "cursor/task") current.respond(message.id, { outcome: { outcome: "completed" } });
      else current.respond(message.id, { outcome: { outcome: "rejected", reason: "聊天不生成图片" } });
      return;
    }
    current.reject(message.id, "不处理该方法");
  });

  const onAbort = () => {
    if (sessionId) current.notify("session/cancel", { sessionId });
  };
  signal?.addEventListener("abort", onAbort);

  try {
    if (signal?.aborted) return "cancelled";
    let opened: unknown = null;
    if (input.agentId) {
      try {
        opened = await current.request("session/load", { sessionId: input.agentId, cwd, mcpServers: [] });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message.includes("ACP 进程已退出")) throw error;
        opened = null;
      }
      if (!stringOf(asRecord(opened).sessionId)) opened = null;
    }
    if (!opened) opened = await current.request("session/new", { cwd, mcpServers: [] });
    const session = asRecord(opened);
    sessionId = stringOf(session.sessionId) ?? "";
    if (!sessionId) {
      emit({ type: "error", message: "ACP 没有返回会话" });
      return "error";
    }
    if (sessionId !== input.agentId) input.onAgent?.(sessionId);

    const modes = availableModes(session.modes);
    if (!modes) {
      emit({ type: "error", message: "ACP 没有声明模式切换" });
      return "error";
    }
    if (!modes.includes(mode)) {
      emit({ type: "error", message: `ACP 没有 ${mode} 模式` });
      return "error";
    }
    await current.request("session/set_mode", { sessionId, modeId: mode });

    const modelOption = modelConfig(session.configOptions);
    if (!modelOption) {
      emit({ type: "error", message: "ACP 没有声明模型切换" });
      return "error";
    }
    if (input.model && modelOption.currentValue !== input.model) {
      await current.request("session/set_config_option", { sessionId, configId: modelOption.id, value: input.model });
    }
    for (const param of input.modelParams ?? []) {
      const option = configById(session.configOptions).get(param.id);
      if (!option || option.id === modelOption.id || option.currentValue === param.value) continue;
      await current.request("session/set_config_option", { sessionId, configId: option.id, value: param.value });
    }

    const result = await current.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: input.prompt }],
    });
    if (signal?.aborted) return "cancelled";
    const stopReason = stringOf(asRecord(result).stopReason);
    if (stopReason === "cancelled") return "cancelled";
    if (stopReason === "refusal") {
      emit({ type: "error", message: "agent 拒绝继续" });
      return "error";
    }
    return "finished";
  } catch (error) {
    if (signal?.aborted) return "cancelled";
    const message = error instanceof Error ? error.message : "run failed";
    if (message.includes("ACP 进程已退出")) drop();
    emit({ type: "error", message });
    return "error";
  } finally {
    signal?.removeEventListener("abort", onAbort);
    unsubscribe();
  }

  function handleUpdate(update: unknown) {
    const raw = asRecord(update);
    const kind = stringOf(raw.sessionUpdate);
    if (kind === "agent_message_chunk") {
      const text = chunkText(raw.content);
      if (text) emit({ type: "text", text });
      return;
    }
    if (kind === "agent_thought_chunk") {
      const text = chunkText(raw.content);
      if (text) emit({ type: "thinking", text });
      return;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      const status = stringOf(raw.status);
      const callId = stringOf(raw.toolCallId);
      if (!callId) return;
      const name = stringOf(raw.name) ?? stringOf(raw.title) ?? stringOf(raw.kind) ?? "tool";
      const detail = toolDetail(raw.rawInput) ?? locationPath(raw.locations);
      const event = { callId, name, ...(detail ? { detail } : {}) };
      if (status === "completed" || status === "failed") {
        if (!started.has(callId)) {
          started.add(callId);
          emit({ type: "tool-start", ...event });
        }
        emit({ type: "tool-end", ...event });
        return;
      }
      if (!started.has(callId)) {
        started.add(callId);
        emit({ type: "tool-start", ...event });
      }
    }
  }
}

class ProcessLink implements AcpLink {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Set<(message: AcpIncoming) => void>();
  private closed = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const message = parseLine(line);
      if (!message) return;
      if (message.id !== undefined && (message.result !== undefined || message.error)) {
        const waiter = this.pending.get(Number(message.id));
        if (!waiter) return;
        this.pending.delete(Number(message.id));
        if (message.error) waiter.reject(new Error(message.error.message || "ACP 请求失败"));
        else waiter.resolve(message.result);
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
    child.on("exit", () => {
      this.closed = true;
      for (const waiter of this.pending.values()) waiter.reject(new Error("ACP 进程已退出"));
      this.pending.clear();
    });
    child.on("error", (error) => {
      this.closed = true;
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("ACP 进程已退出"));
    const id = this.nextId++;
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolveRequest, rejectRequest) => {
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  respond(id: number | string, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  reject(id: number | string, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code: -32601, message } });
  }

  subscribe(listener: (message: AcpIncoming) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    this.child.stdin.end();
    this.child.kill();
  }

  private write(message: unknown) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

function availableModes(value: unknown): string[] | null {
  const modes = asRecord(value);
  const list = modes.availableModes;
  if (!Array.isArray(list) || list.length === 0) return null;
  const ids = list.flatMap((item) => {
    const id = stringOf(asRecord(item).id);
    return id ? [id] : [];
  });
  return ids.length ? ids : null;
}

function configById(value: unknown): Map<string, { id: string; currentValue?: string }> {
  const found = new Map<string, { id: string; currentValue?: string }>();
  if (!Array.isArray(value)) return found;
  for (const item of value) {
    const option = asRecord(item);
    const id = stringOf(option.id);
    if (!id) continue;
    found.set(id, { id, currentValue: stringOf(option.currentValue) });
  }
  return found;
}

function modelConfig(value: unknown): { id: string; currentValue?: string } | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    const option = asRecord(item);
    const id = stringOf(option.id);
    const category = stringOf(option.category);
    if (!id || (category !== "model" && id !== "model")) continue;
    return { id, currentValue: stringOf(option.currentValue) };
  }
  return null;
}

function locationPath(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    const path = stringOf(asRecord(item).path);
    if (path) return toolDetail({ path });
  }
  return undefined;
}

function chunkText(value: unknown): string {
  return stringOf(asRecord(value).text) ?? "";
}

function isWrite(tool: ToolShape): boolean {
  if (tool.kind && writeKinds.has(tool.kind)) return true;
  if (tool.name && writeName.test(tool.name)) return true;
  if (tool.title && writeName.test(tool.title)) return true;
  const input = asRecord(tool.rawInput);
  return typeof input.command === "string" || typeof input.cmd === "string";
}

function sameKind(value: string | undefined, expected: string): boolean {
  return (value ?? "").replaceAll("-", "_").toLowerCase() === expected;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function parseLine(line: string): AcpIncoming | null {
  try {
    return JSON.parse(line) as AcpIncoming;
  } catch {
    return null;
  }
}

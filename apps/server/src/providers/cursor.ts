import type { GatewayEvent } from "@gateway/shared";
import type { AgentRuntime, GatewayTool, RunContext } from "../runs.js";
import { accessForChat, cursorAccess, promptWithRules, withRules, type CursorAccess } from "./access.js";
import { classifyCursorFailure, mapCursorEvent, type CursorStreamEvent, type ModelInfo } from "./map.js";

export type CursorRun = {
  stream: () => AsyncIterable<CursorStreamEvent>;
  wait: () => Promise<{ status: "finished" | "error" | "cancelled" }>;
  cancel: () => Promise<void>;
};

export type CursorSendOptions = {
  model: { id: string };
  mode: CursorAccess["mode"];
  customTools?: Record<string, GatewayTool>;
};

export type CursorAgent = {
  agentId: string;
  send: (prompt: string, options: CursorSendOptions) => Promise<CursorRun>;
};

export type CursorAgentOptions = { cwd: string; model: string; access: CursorAccess };

export type CursorSdk = {
  models: ModelInfo[];
  create: (options: CursorAgentOptions) => Promise<CursorAgent>;
  resume: (agentId: string, options: CursorAgentOptions) => Promise<CursorAgent>;
};

export function createCursorRuntime(sdk: CursorSdk): AgentRuntime {
  return {
    async listModels() {
      return sdk.models;
    },
    async startRun(input, emit, signal) {
      try {
        const profile = input.access ?? "chat";
        const access = profile === "chat" ? accessForChat(input.chatMode) : cursorAccess[profile];
        const options = { cwd: input.cwd, model: input.model, access };
        const agent = input.agentId ? await sdk.resume(input.agentId, options) : await sdk.create(options);
        if (agent.agentId !== input.agentId) input.onAgent?.(agent.agentId);
        const run = await agent.send(profile === "chat" ? promptWithRules(access, input.prompt) : withRules(profile, input.prompt), {
          model: { id: input.model },
          mode: access.mode,
          customTools: input.customTools,
        });
        const onAbort = () => void run.cancel();
        signal?.addEventListener("abort", onAbort);
        for await (const event of run.stream()) {
          for (const mapped of mapCursorEvent(event)) emit(mapped);
        }
        const result = await run.wait();
        signal?.removeEventListener("abort", onAbort);
        if (result.status === "error") {
          emit({ type: "error", message: "run failed" });
          return "error";
        }
        emit({ type: "done", status: result.status === "cancelled" ? "cancelled" : "finished" });
        return result.status === "cancelled" ? "cancelled" : "finished";
      } catch (error) {
        const kind = classifyCursorFailure(error);
        emit({ type: "error", message: kind === "startup" ? `startup: ${(error as Error).message}` : "run failed" });
        return "error";
      }
    },
  };
}

export function trackModels(runtime: AgentRuntime, bag: string[]): AgentRuntime {
  const inner = runtime.startRun.bind(runtime);
  return {
    ...runtime,
    async startRun(input: RunContext, emit: (event: GatewayEvent) => void, signal?: AbortSignal) {
      bag.push(input.model);
      return inner(input, emit, signal);
    },
  };
}

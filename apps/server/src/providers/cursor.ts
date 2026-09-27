import type { GatewayEvent } from "@gateway/shared";
import type { AgentRuntime, RunContext } from "../runs.js";
import { classifyCursorFailure, mapCursorEvent, type CursorStreamEvent, type ModelInfo } from "./map.js";

export type CursorRun = {
  stream: () => AsyncIterable<CursorStreamEvent>;
  wait: () => Promise<{ status: "finished" | "error" | "cancelled" }>;
  cancel: () => Promise<void>;
};

export type CursorAgent = {
  agentId: string;
  send: (prompt: string, options: { model: { id: string } }) => Promise<CursorRun>;
};

export type CursorSdk = {
  models: ModelInfo[];
  create: (cwd: string, model: string) => Promise<CursorAgent>;
  resume: (agentId: string, cwd: string) => Promise<CursorAgent>;
};

export function createCursorRuntime(sdk: CursorSdk, remember: (sessionId: string, agentId: string) => void, lookup: (sessionId: string) => string | null): AgentRuntime {
  return {
    async listModels() {
      return sdk.models;
    },
    async startRun(input, emit, signal) {
      try {
        const existing = lookup(input.sessionId);
        const agent = existing ? await sdk.resume(existing, input.cwd) : await sdk.create(input.cwd, input.model);
        remember(input.sessionId, agent.agentId);
        const run = await agent.send(input.prompt, { model: { id: input.model } });
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

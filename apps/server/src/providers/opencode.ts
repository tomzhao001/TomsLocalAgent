import type { AgentRuntime } from "../runs.js";
import { takeOpencodePart, type ModelInfo } from "./map.js";

export type OpenCodeEvent = {
  type?: string;
  properties?: { part?: { id?: string; type?: string; text?: string; tool?: string; sessionID?: string; time?: { end?: number }; state?: { status?: string } } };
};

export type OpenCodeClient = {
  models: ModelInfo[];
  prompt: (input: { sessionId: string; directory: string; model: string; text: string }) => Promise<void>;
  events: (sessionId: string) => AsyncIterable<OpenCodeEvent>;
  abort: (sessionId: string) => Promise<void>;
  ensureSession: (gatewaySessionId: string, directory: string) => Promise<string>;
};

export function createOpenCodeRuntime(client: OpenCodeClient): AgentRuntime {
  return {
    async listModels() {
      return client.models;
    },
    async startRun(input, emit, signal) {
      if (input.access && input.access !== "chat") {
        emit({ type: "error", message: "OpenCode 只能用于只读聊天" });
        return "error";
      }
      const ocSession = input.agentId ?? (await client.ensureSession(input.sessionId, input.cwd));
      if (ocSession !== input.agentId) input.onAgent?.(ocSession);
      const seen = new Set<string>();
      await client.prompt({ sessionId: ocSession, directory: input.cwd, model: input.model, text: input.prompt });
      const onAbort = () => void client.abort(ocSession);
      signal?.addEventListener("abort", onAbort);
      try {
        for await (const event of client.events(ocSession)) {
          if (signal?.aborted) return "cancelled";
          const mapped = takeOpencodePart(seen, event);
          if (mapped) emit(mapped);
          if (event.type === "session.idle") {
            emit({ type: "done", status: "finished" });
            return "finished";
          }
        }
        return "finished";
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

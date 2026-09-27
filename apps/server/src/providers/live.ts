import type { AgentRuntime } from "../runs.js";
import { createCursorRuntime, type CursorSdk } from "./cursor.js";
import { createOpenCodeRuntime } from "./opencode.js";
import { cachedModels, flattenOpenCodeModels } from "./map.js";

type Memory = {
  get(sessionId: string): string | null;
  set(sessionId: string, agentId: string): void;
};

export async function loadCursorRuntime(apiKey: string, memory: Memory): Promise<AgentRuntime> {
  const sdk = (await import("@cursor/sdk")) as any;
  const models = cachedModels(async () => {
    const listed = await sdk.Cursor.models.list({ apiKey });
    return (listed ?? []).map((item: { id: string; name?: string }) => ({ id: item.id, label: item.name ?? item.id }));
  });
  const cursor = createCursorRuntime(adapt(sdk, apiKey), (sessionId, agentId) => memory.set(sessionId, agentId), (sessionId) => memory.get(sessionId));
  return { ...cursor, listModels: models };
}

export type OpenCodeHandle = { runtime: AgentRuntime; close: () => void };

export async function loadOpenCodeRuntime(options: { port: number; password?: string }): Promise<OpenCodeHandle> {
  const sdk = (await import("@opencode-ai/sdk")) as any;
  const server = await sdk.createOpencodeServer({ hostname: "127.0.0.1", port: options.port, timeout: 20_000 });
  const headers: Record<string, string> = {};
  if (options.password) {
    const user = process.env.OPENCODE_SERVER_USERNAME || "opencode";
    headers.Authorization = `Basic ${Buffer.from(`${user}:${options.password}`).toString("base64")}`;
  }
  const client = sdk.createOpencodeClient({ baseUrl: server.url, headers });
  const sessions = new Map<string, string>();
  const listModels = cachedModels(async () => flattenOpenCodeModels(await client.app.providers()));
  const runtime = createOpenCodeRuntime({
    models: [],
    async prompt(input) {
      const [providerID, modelID] = splitModel(input.model);
      await client.session.promptAsync({
        path: { id: input.sessionId },
        query: { directory: input.directory },
        body: { model: { providerID, modelID }, parts: [{ type: "text", text: input.text }] },
      });
    },
    async *events(sessionId) {
      const stream = await client.event.subscribe();
      for await (const event of stream.stream ?? stream) {
        const partSession = event?.properties?.part?.sessionID;
        if (!partSession || partSession === sessionId) yield event;
        if (event?.type === "session.idle" && event?.properties?.sessionID === sessionId) return;
      }
    },
    async abort(sessionId) {
      await client.session.abort({ path: { id: sessionId } });
    },
    async ensureSession(gatewaySessionId, directory) {
      const existing = sessions.get(gatewaySessionId);
      if (existing) return existing;
      const created = await client.session.create({ body: { title: gatewaySessionId }, query: { directory } });
      const id = created?.data?.id ?? created?.id;
      sessions.set(gatewaySessionId, id);
      return id;
    },
  });
  return { runtime: { ...runtime, listModels }, close: () => server.close() };
}

function adapt(sdk: any, apiKey: string): CursorSdk {
  return {
    models: [],
    async create(cwd, model) {
      const agent = await sdk.Agent.create({ apiKey, model: { id: model }, local: { cwd } });
      return wrap(agent);
    },
    async resume(agentId) {
      const agent = await sdk.Agent.resume(agentId, { apiKey });
      return wrap(agent);
    },
  };
}

function wrap(agent: any) {
  return {
    agentId: agent.agentId as string,
    async send(prompt: string, options: { model: { id: string } }) {
      const run = await agent.send(prompt, { model: options.model });
      return {
        stream: () => run.stream(),
        wait: () => run.wait(),
        cancel: () => run.cancel(),
      };
    },
  };
}

function splitModel(model: string): [string, string] {
  const index = model.indexOf("/");
  if (index < 0) return ["opencode", model];
  return [model.slice(0, index), model.slice(index + 1)];
}

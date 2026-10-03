import type { AgentRuntime, GatewayTool } from "../runs.js";
import { opencodeReadonly } from "./access.js";
import { createCursorRuntime, type CursorAgentOptions, type CursorSdk, type CursorSendOptions } from "./cursor.js";
import { createOpenCodeRuntime } from "./opencode.js";
import { cachedModels, flattenOpenCodeModels, mapCursorModels, modelSelection } from "./map.js";

export async function loadCursorRuntime(apiKey: string): Promise<AgentRuntime> {
  const sdk = (await import("@cursor/sdk")) as any;
  const models = cachedModels(async () => {
    return mapCursorModels(await sdk.Cursor.models.list({ apiKey }));
  });
  const cursor = createCursorRuntime(adapt(sdk, apiKey));
  return { ...cursor, listModels: models };
}

export type OpenCodeHandle = { runtime: AgentRuntime; close: () => void };

export async function loadOpenCodeRuntime(options: { port: number; password?: string }): Promise<OpenCodeHandle> {
  const sdk = (await import("@opencode-ai/sdk")) as any;
  const server = await sdk.createOpencodeServer({
    hostname: "127.0.0.1",
    port: options.port,
    timeout: 20_000,
    config: { permission: opencodeReadonly.permission },
  });
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
        body: {
          model: { providerID, modelID },
          agent: opencodeReadonly.agent,
          tools: opencodeReadonly.tools,
          parts: [{ type: "text", text: input.text }],
        },
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

export function cursorSdkAgentOptions(apiKey: string, options: CursorAgentOptions) {
  return {
    apiKey,
    model: modelSelection(options.model, options.modelParams),
    mode: options.access.mode,
    ...(options.access.tools ? { tools: options.access.tools } : {}),
    local: {
      cwd: options.cwd,
      ...(options.settingSources?.length ? { settingSources: options.settingSources } : {}),
    },
  };
}

function adapt(sdk: any, apiKey: string): CursorSdk {
  const agentOptions = (options: CursorAgentOptions) => cursorSdkAgentOptions(apiKey, options);
  return {
    models: [],
    async create(options) {
      return wrap(await sdk.Agent.create(agentOptions(options)));
    },
    async resume(agentId, options) {
      return wrap(await sdk.Agent.resume(agentId, agentOptions(options)));
    },
  };
}

function wrap(agent: any) {
  return {
    agentId: agent.agentId as string,
    async send(prompt: string, options: CursorSendOptions) {
      const run = await agent.send(prompt, {
        model: options.model,
        mode: options.mode,
        ...(options.customTools ? { local: { customTools: toSdkTools(options.customTools) } } : {}),
      });
      return {
        stream: () => run.stream(),
        wait: () => run.wait(),
        cancel: () => run.cancel(),
      };
    },
  };
}

function toSdkTools(tools: Record<string, GatewayTool>) {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [
      name,
      { description: tool.description, inputSchema: tool.inputSchema, execute: (args: Record<string, unknown>) => tool.execute(args) },
    ]),
  );
}

function splitModel(model: string): [string, string] {
  const index = model.indexOf("/");
  if (index < 0) return ["opencode", model];
  return [model.slice(0, index), model.slice(index + 1)];
}

import type { GatewayEvent } from "@gateway/shared";

export type CursorStreamEvent = {
  type: string;
  text?: string;
  call_id?: string;
  name?: string;
  status?: string;
  args?: unknown;
  usage?: GatewayEvent extends { type: "usage"; usage: infer U } ? U : never;
  message?: { content?: { type: string; text?: string }[] };
};

const detailKeys = ["path", "file_path", "filePath", "target_file", "command", "cmd", "query"];

export function toolDetail(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  for (const key of detailKeys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return clipDetail(value);
  }
  return undefined;
}

function clipDetail(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine;
}

export type StepTrace = {
  callId: string;
  name: string;
  status: "running" | "completed";
  detail?: string;
};

export function traceFromEvent(event: GatewayEvent): StepTrace | null {
  if (event.type !== "tool-start" && event.type !== "tool-end") return null;
  return {
    callId: event.callId,
    name: event.name,
    status: event.type === "tool-start" ? "running" : "completed",
    ...(event.detail ? { detail: event.detail } : {}),
  };
}

export function mapCursorEvent(event: CursorStreamEvent): GatewayEvent[] {
  if (event.type === "assistant") {
    return (event.message?.content ?? [])
      .filter((block) => block.type === "text" && block.text)
      .map((block) => ({ type: "text", text: block.text! }));
  }
  if (event.type === "thinking" && event.text) return [{ type: "thinking", text: event.text }];
  if (event.type === "tool_call" && event.call_id && event.name) {
    const detail = toolDetail(event.args);
    return [
      {
        type: event.status === "running" ? "tool-start" : "tool-end",
        callId: event.call_id,
        name: event.name,
        ...(detail ? { detail } : {}),
      },
    ];
  }
  if (event.type === "usage" && event.usage) return [{ type: "usage", usage: event.usage }];
  return [];
}

export function classifyCursorFailure(error: unknown): "startup" | "run" {
  if (error && typeof error === "object" && (error as { name?: string }).name === "CursorAgentError") return "startup";
  return "run";
}

type OcPart = {
  id?: string;
  type?: string;
  text?: string;
  tool?: string;
  time?: { end?: number };
  state?: { status?: string };
};

export function takeOpencodePart(seen: Set<string>, event: { type?: string; properties?: { part?: OcPart } }): GatewayEvent | null {
  if (event.type !== "message.part.updated") return null;
  const part = event.properties?.part;
  if (!part?.id || seen.has(part.id)) return null;
  if (part.type === "text" && part.time?.end) {
    seen.add(part.id);
    return { type: "text", text: part.text ?? "" };
  }
  if (part.type === "reasoning" && part.time?.end) {
    seen.add(part.id);
    return { type: "thinking", text: part.text ?? "" };
  }
  if (part.type === "tool" && (part.state?.status === "completed" || part.state?.status === "error")) {
    seen.add(part.id);
    return { type: "tool-end", callId: part.id, name: part.tool ?? "tool" };
  }
  return null;
}

export type ModelInfo = { id: string; label: string };

export type OpenCodeProviderConfig = {
  id?: string;
  name?: string;
  models?: Record<string, { name?: string } | undefined>;
};

export function flattenOpenCodeModels(config: {
  providers?: OpenCodeProviderConfig[];
  data?: { providers?: OpenCodeProviderConfig[] };
} | null | undefined): ModelInfo[] {
  const providers = config?.providers ?? config?.data?.providers ?? [];
  const items: ModelInfo[] = [];
  for (const provider of providers) {
    const providerID = provider.id || provider.name;
    if (!providerID) continue;
    for (const [modelID, model] of Object.entries(provider.models ?? {})) {
      items.push({ id: `${providerID}/${modelID}`, label: model?.name ?? `${providerID}/${modelID}` });
    }
  }
  return items;
}

export function cachedModels(load: () => Promise<ModelInfo[]>, ttlMs = 10 * 60 * 1000, now = () => Date.now()) {
  let cache: { at: number; models: ModelInfo[] } | null = null;
  return async () => {
    if (cache && now() - cache.at < ttlMs) return cache.models;
    cache = { at: now(), models: await load() };
    return cache.models;
  };
}

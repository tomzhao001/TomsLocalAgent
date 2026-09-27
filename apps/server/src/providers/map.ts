import type { GatewayEvent } from "@gateway/shared";

export type CursorStreamEvent = {
  type: string;
  text?: string;
  call_id?: string;
  name?: string;
  status?: string;
  usage?: GatewayEvent extends { type: "usage"; usage: infer U } ? U : never;
  message?: { content?: { type: string; text?: string }[] };
};

export function mapCursorEvent(event: CursorStreamEvent): GatewayEvent[] {
  if (event.type === "assistant") {
    return (event.message?.content ?? [])
      .filter((block) => block.type === "text" && block.text)
      .map((block) => ({ type: "text", text: block.text! }));
  }
  if (event.type === "thinking" && event.text) return [{ type: "thinking", text: event.text }];
  if (event.type === "tool_call" && event.call_id && event.name) {
    return [
      {
        type: event.status === "running" ? "tool-start" : "tool-end",
        callId: event.call_id,
        name: event.name,
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

export function cachedModels(load: () => Promise<ModelInfo[]>, ttlMs = 10 * 60 * 1000, now = () => Date.now()) {
  let cache: { at: number; models: ModelInfo[] } | null = null;
  return async () => {
    if (cache && now() - cache.at < ttlMs) return cache.models;
    cache = { at: now(), models: await load() };
    return cache.models;
  };
}

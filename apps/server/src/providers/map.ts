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

export type ModelParam = { id: string; value: string };
export type ModelParameter = { id: string; label: string; values: { value: string; label: string }[] };
export type ModelVariant = { label: string; params: ModelParam[]; isDefault?: boolean };
export type ModelInfo = {
  id: string;
  label: string;
  parameters?: ModelParameter[];
  variants?: ModelVariant[];
};

export function mapCursorModels(listed: unknown): ModelInfo[] {
  if (!Array.isArray(listed)) return [];
  const items: ModelInfo[] = [];
  for (const raw of listed) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const id = text(item.id);
    if (!id) continue;
    const parameters = mapParameters(item.parameters);
    const variants = mapVariants(item.variants);
    items.push({
      id,
      label: text(item.displayName) ?? text(item.name) ?? id,
      ...(parameters.length ? { parameters } : {}),
      ...(variants.length ? { variants } : {}),
    });
  }
  return items;
}

export function parseModelParams(value: unknown): ModelParam[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const params: ModelParam[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const id = text(item.id);
    const paramValue = text(item.value);
    if (!id || !paramValue) continue;
    params.push({ id, value: paramValue });
  }
  return params.length ? params : undefined;
}

export function modelSelection(id: string, params?: ModelParam[]): { id: string; params?: ModelParam[] } {
  return params?.length ? { id, params } : { id };
}

export function formatVariantId(id: string, params: ModelParam[]): string {
  const body = params.filter((param) => param.id && param.value).map((param) => `${param.id}=${param.value}`);
  if (!id) return "";
  return body.length ? `${id}[${body.join(",")}]` : id;
}

export function parseVariantId(stored: string): { id: string; params: ModelParam[] } {
  const trimmed = stored.trim();
  const open = trimmed.indexOf("[");
  if (open <= 0 || !trimmed.endsWith("]")) return { id: trimmed, params: [] };
  const id = trimmed.slice(0, open);
  const body = trimmed.slice(open + 1, -1).trim();
  if (!body) return { id, params: [] };
  const params: ModelParam[] = [];
  for (const part of body.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const paramId = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!paramId || !value) continue;
    params.push({ id: paramId, value });
  }
  return { id, params };
}

export function matchVariant(model: ModelInfo | undefined, current: ModelParam[], changed?: ModelParam): ModelParam[] {
  const parameters = model?.parameters ?? [];
  if (!parameters.length) return [];
  const desired = parameters.flatMap((param) => {
    const value = param.id === changed?.id ? changed.value : current.find((item) => item.id === param.id)?.value;
    if (!value || !param.values.some((item) => item.value === value)) return [];
    return [{ id: param.id, value }];
  });
  const variants = model?.variants ?? [];
  if (!variants.length) return normalizeParams(model, desired);

  let pool = variants;
  if (changed) {
    const supporting = variants.filter((variant) =>
      variant.params.some((item) => item.id === changed.id && item.value === changed.value),
    );
    if (supporting.length) pool = supporting;
    else {
      const defaults = variants.filter((variant) => variant.isDefault);
      pool = defaults.length ? defaults : variants;
    }
  }
  let best = pool[0];
  let bestKept = -1;
  for (const variant of pool) {
    let kept = 0;
    for (const param of desired) {
      if (changed && param.id === changed.id) continue;
      if (variant.params.some((item) => item.id === param.id && item.value === param.value)) kept += 1;
    }
    if (!best || kept > bestKept || (kept === bestKept && variant.isDefault && !best.isDefault)) {
      best = variant;
      bestKept = kept;
    }
  }
  return parameters.flatMap((param) => {
    const value = best?.params.find((item) => item.id === param.id)?.value;
    return value ? [{ id: param.id, value }] : [];
  });
}

export function resolveStoredModel(models: ModelInfo[], stored: string): { id: string; params?: ModelParam[] } {
  const parsed = parseVariantId(stored);
  if (!parsed.id) return { id: stored };
  const model = models.find((item) => item.id === parsed.id);
  if (!model?.parameters?.length) return modelSelection(parsed.id, parsed.params);
  return modelSelection(parsed.id, matchVariant(model, parsed.params));
}

function normalizeParams(model: ModelInfo | undefined, current: ModelParam[]): ModelParam[] {
  const parameters = model?.parameters ?? [];
  const next = parameters.flatMap((param) => {
    const selected = current.find((item) => item.id === param.id)?.value;
    if (!selected || !param.values.some((item) => item.value === selected)) return [];
    return [{ id: param.id, value: selected }];
  });
  if (next.length === parameters.length) return next;
  const preset = model?.variants?.find((item) => item.isDefault);
  return parameters.flatMap((param) => {
    const preferred = preset?.params.find((item) => item.id === param.id)?.value;
    const value = param.values.some((item) => item.value === preferred) ? preferred : param.values[0]?.value;
    return value ? [{ id: param.id, value }] : [];
  });
}

function mapParameters(value: unknown): ModelParameter[] {
  if (!Array.isArray(value)) return [];
  const parameters: ModelParameter[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const id = text(item.id);
    if (!id || !Array.isArray(item.values)) continue;
    const values = item.values.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const option = entry as Record<string, unknown>;
      const optionValue = text(option.value);
      if (!optionValue) return [];
      return [{ value: optionValue, label: text(option.displayName) ?? optionValue }];
    });
    if (!values.length) continue;
    parameters.push({ id, label: text(item.displayName) ?? id, values });
  }
  return parameters;
}

function mapVariants(value: unknown): ModelVariant[] {
  if (!Array.isArray(value)) return [];
  const variants: ModelVariant[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const params = parseModelParams(item.params);
    if (!params) continue;
    variants.push({
      label: text(item.displayName) ?? params.map((param) => param.value).join(" "),
      params,
      ...(item.isDefault === true ? { isDefault: true } : {}),
    });
  }
  return variants;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

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

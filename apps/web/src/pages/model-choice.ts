export type ModelParam = { id: string; value: string };
export type ModelParameter = { id: string; label: string; values: { value: string; label: string }[] };
export type ModelVariant = { label: string; params: ModelParam[]; isDefault?: boolean };
export type ModelInfo = {
  id: string;
  label: string;
  parameters?: ModelParameter[];
  variants?: ModelVariant[];
};

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

export function pickModelId(listed: ModelInfo[], current: string, chatModel: string): string {
  const currentId = parseVariantId(current).id;
  if (currentId && listed.some((item) => item.id === currentId)) return currentId;
  const storedId = parseVariantId(chatModel).id;
  if (storedId) return storedId;
  return listed.find((item) => item.id === "auto")?.id ?? listed[0]?.id ?? "";
}

export function defaultModelParams(model: ModelInfo | undefined): ModelParam[] {
  const parameters = model?.parameters ?? [];
  const preset = model?.variants?.find((item) => item.isDefault);
  return parameters.flatMap((param) => {
    const preferred = preset?.params.find((item) => item.id === param.id)?.value;
    const value = param.values.some((item) => item.value === preferred) ? preferred : param.values[0]?.value;
    return value ? [{ id: param.id, value }] : [];
  });
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
  if (!variants.length) return normalizeModelParams(model, desired);

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

export function normalizeModelParams(model: ModelInfo | undefined, current: ModelParam[]): ModelParam[] {
  const parameters = model?.parameters ?? [];
  if (!parameters.length) return [];
  const next = parameters.flatMap((param) => {
    const selected = current.find((item) => item.id === param.id)?.value;
    if (!selected || !param.values.some((item) => item.value === selected)) return [];
    return [{ id: param.id, value: selected }];
  });
  return next.length === parameters.length ? next : defaultModelParams(model);
}

export function parameterValues(model: ModelInfo | undefined, param: ModelParameter): { value: string; label: string }[] {
  const variants = model?.variants ?? [];
  if (!variants.length) return param.values;
  const seen = new Set(
    variants.flatMap((variant) => {
      const value = variant.params.find((item) => item.id === param.id)?.value;
      return value ? [value] : [];
    }),
  );
  const listed = param.values.filter((item) => seen.has(item.value));
  return listed.length ? listed : param.values;
}

export function canonicalStoredModel(models: ModelInfo[], stored: string): string {
  const trimmed = stored.trim();
  if (!trimmed) return "";
  const parsed = parseVariantId(trimmed);
  const model = models.find((item) => item.id === parsed.id);
  if (!model) return trimmed;
  const params = model.parameters?.length ? matchVariant(model, parsed.params) : parsed.params;
  return formatVariantId(parsed.id, params);
}

export function modelSummary(model: ModelInfo | undefined, params: ModelParam[]): string {
  if (!model) return "暂无模型";
  const parts = [model.label];
  for (const param of model.parameters ?? []) {
    const selected = params.find((item) => item.id === param.id)?.value;
    if (!selected) continue;
    parts.push(param.values.find((item) => item.value === selected)?.label ?? selected);
  }
  return parts.join(" · ");
}

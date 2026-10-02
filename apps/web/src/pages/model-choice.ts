export type ModelParam = { id: string; value: string };
export type ModelParameter = { id: string; label: string; values: { value: string; label: string }[] };
export type ModelVariant = { label: string; params: ModelParam[]; isDefault?: boolean };
export type ModelInfo = {
  id: string;
  label: string;
  parameters?: ModelParameter[];
  variants?: ModelVariant[];
};

export function pickModelId(listed: ModelInfo[], current: string, chatModel: string): string {
  if (current && listed.some((item) => item.id === current)) return current;
  if (chatModel) return chatModel;
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

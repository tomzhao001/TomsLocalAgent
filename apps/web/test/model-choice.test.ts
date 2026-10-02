import { describe, expect, it } from "vitest";
import { canonicalStoredModel, matchVariant, parseVariantId, pickModelId, type ModelInfo } from "../src/pages/model-choice";

const grok: ModelInfo = {
  id: "grok-4.7",
  label: "Grok 4.7",
  parameters: [
    { id: "context", label: "上下文", values: [{ value: "256k", label: "256k" }, { value: "500k", label: "500k" }] },
    { id: "reasoning_effort", label: "推理", values: [{ value: "low", label: "low" }, { value: "high", label: "high" }] },
    { id: "fast", label: "fast", values: [{ value: "false", label: "标准" }, { value: "true", label: "Fast" }] },
  ],
  variants: [
    {
      label: "默认",
      isDefault: true,
      params: [
        { id: "context", value: "500k" },
        { id: "reasoning_effort", value: "high" },
        { id: "fast", value: "true" },
      ],
    },
    {
      label: "短",
      params: [
        { id: "context", value: "256k" },
        { id: "reasoning_effort", value: "low" },
        { id: "fast", value: "false" },
      ],
    },
  ],
};

describe("模型变体", () => {
  it("改一个参数时落到最接近的真实组合，裸 id 用默认变体", () => {
    const stored = "grok-4.7[context=500k,reasoning_effort=high,fast=true]";
    expect(parseVariantId(stored).id).toBe("grok-4.7");
    expect(pickModelId([grok], "", stored)).toBe("grok-4.7");
    expect(matchVariant(grok, grok.variants![0]!.params, { id: "context", value: "256k" })).toEqual(grok.variants![1]!.params);
    expect(canonicalStoredModel([grok], "grok-4.7")).toBe("grok-4.7[context=500k,reasoning_effort=high,fast=true]");
    expect(canonicalStoredModel([grok], "")).toBe("");
  });
});

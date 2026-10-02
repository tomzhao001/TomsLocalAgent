import { describe, expect, it } from "vitest";
import { appendLogEvent } from "../src/pages/chat-log";

describe("聊天日志折叠", () => {
  it("计划事件展示正文，随后的待办更新同一张卡片", () => {
    const bubbles = [
      { type: "text" as const, text: "先看" },
      {
        type: "plan" as const,
        plan: { name: "登录", plan: "1. 改表单", todos: [{ id: "t1", content: "改表单", status: "pending" as const }] },
      },
      { type: "todos" as const, todos: [{ id: "t1", content: "改表单", status: "completed" as const }] },
      { type: "error" as const, message: "ACP 没有声明模式切换" },
    ].reduce(appendLogEvent, []);
    expect(bubbles.map((item) => item.role)).toEqual(["assistant", "plan", "error"]);
    expect(bubbles[1]).toMatchObject({ role: "plan", plan: { plan: "1. 改表单", todos: [{ status: "completed" }] } });
  });

  it("连续文本和思考各自合成一块，工具之后再开一段", () => {
    const bubbles = [
      { type: "text" as const, text: "你" },
      { type: "text" as const, text: "好" },
      { type: "thinking" as const, text: "想" },
      { type: "thinking" as const, text: "一下" },
      { type: "tool-start" as const, callId: "c1", name: "read", detail: "a.ts" },
      { type: "tool-end" as const, callId: "c1", name: "read" },
      { type: "text" as const, text: "看完" },
    ].reduce(appendLogEvent, []);
    expect(bubbles.map((item) => item.role)).toEqual(["assistant", "thinking", "tool", "assistant"]);
    expect(bubbles[0]).toMatchObject({ text: "你好" });
    expect(bubbles[1]).toMatchObject({ text: "想一下" });
    expect(bubbles[2]).toMatchObject({ running: false, detail: "a.ts" });
    expect(bubbles[3]).toMatchObject({ text: "看完" });
  });

  it("结束事件单独成一条，不并进正文", () => {
    const bubbles = [
      { type: "text" as const, text: "好" },
      { type: "done" as const, status: "finished" },
    ].reduce(appendLogEvent, []);
    expect(bubbles).toEqual([
      { role: "assistant", text: "好" },
      { role: "done", status: "finished" },
    ]);
  });
});

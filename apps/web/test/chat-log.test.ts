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
});

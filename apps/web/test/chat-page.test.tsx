import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatPage } from "../src/pages/Chat";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("聊天页", () => {
  it("Cursor 默认是提问，刷新后展示计划正文和待办", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => response(url)));
    render(<ChatPage workspaceId="ws" onSplitStarted={() => {}} />);
    expect(await screen.findByRole("combobox", { name: "对话方式" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "对话方式" }).textContent).toContain("提问");
    fireEvent.click(await screen.findByRole("button", { name: "Cursor" }));
    expect(await screen.findByText("1. 改表单")).toBeTruthy();
    expect(screen.getByText("待办：改表单")).toBeTruthy();
    expect(screen.getByText("登录")).toBeTruthy();
  });
});

function response(url: string): Response {
  if (url.startsWith("/api/sessions?")) {
    return json([{ id: "s1", provider: "cursor", workspace_id: "ws", workspace_name: "代码", title: null }]);
  }
  if (url.startsWith("/api/providers/")) return json([{ id: "auto", label: "Auto" }]);
  if (url === "/api/sessions/s1/runs") return json([{ id: "r1", status: "finished", prompt: "做个计划" }]);
  if (url.startsWith("/api/runs/r1/log")) {
    return json({
      status: "finished",
      nextOffset: 1,
      events: [
        {
          type: "plan",
          plan: {
            name: "登录",
            overview: "收紧登录",
            plan: "1. 改表单",
            todos: [{ id: "t1", content: "改表单", status: "pending" }],
          },
        },
      ],
    });
  }
  return json({});
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

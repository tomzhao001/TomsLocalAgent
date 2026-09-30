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

  it("进行中的会话订阅事件流，连续文本合成一个气泡，并可以终止", async () => {
    const sources: { url: string; emit: (event: unknown) => void }[] = [];
    vi.stubGlobal(
      "EventSource",
      class {
        url: string;
        withCredentials: boolean;
        onmessage: ((message: { data: string }) => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(url: string, init?: { withCredentials?: boolean }) {
          this.url = url;
          this.withCredentials = init?.withCredentials === true;
          sources.push(this);
        }
        close() {}
        emit(event: unknown) {
          this.onmessage?.({ data: JSON.stringify(event) });
        }
      },
    );
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/runs/r1/cancel" && init?.method === "POST") return json({ ok: true });
      return runningResponse(url);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatPage workspaceId="ws" onSplitStarted={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Cursor" }));
    expect(await screen.findByRole("button", { name: "终止" })).toBeTruthy();
    expect(screen.getByText("正在处理…")).toBeTruthy();
    expect(sources[0]?.url).toBe("/api/runs/r1/events");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/log"))).toBe(false);
    sources[0]?.emit({ type: "text", text: "你" });
    sources[0]?.emit({ type: "text", text: "好" });
    expect(await screen.findByText("你好")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "终止" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/runs/r1/cancel", expect.objectContaining({ method: "POST" })),
    );
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

function runningResponse(url: string): Response {
  if (url.startsWith("/api/sessions?")) {
    return json([{ id: "s1", provider: "cursor", workspace_id: "ws", workspace_name: "代码", title: null }]);
  }
  if (url.startsWith("/api/providers/")) return json([{ id: "auto", label: "Auto" }]);
  if (url === "/api/sessions/s1/runs") return json([{ id: "r1", status: "running", prompt: "在吗" }]);
  return json({});
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatPage, cursorChatTitle } from "../src/pages/Chat";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function chooseRecent(name: string) {
  let history: HTMLElement | undefined;
  await waitFor(() => {
    history = screen.getByRole("combobox", { name: "最近聊天" });
    expect((history as HTMLButtonElement).disabled).toBe(false);
  });
  fireEvent.pointerDown(history!, { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(await screen.findByRole("option", { name }));
}

describe("聊天页", () => {
  it("workspace 的聊天模型会放进发送框，Agent 发送时带上模式", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/sessions/s1/messages" && init?.method === "POST") return json({ runId: "r2" });
      return response(url);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "EventSource",
      class {
        close() {}
      },
    );
    render(<ChatPage workspaceId="ws" chatModel="composer" onSplitStarted={() => {}} />);
    expect((await screen.findAllByText("composer")).length).toBeGreaterThan(0);
    await chooseRecent(cursorChatTitle(sessionCreatedAt));
    await screen.findByText("1. 改表单");
    await waitFor(() => expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.pointerDown(screen.getByRole("combobox", { name: "对话方式" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("option", { name: "Agent" }));
    expect(screen.getByText("Agent 会直接修改这个 workspace 里的文件。")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("输入消息"), { target: { value: "改一下" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => url === "/api/sessions/s1/messages");
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ prompt: "改一下", model: "composer", mode: "agent" });
    });
  });

  it("进入时打开最新聊天，默认是 Agent，刷新后展示计划正文和待办", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => response(url)));
    render(<ChatPage workspaceId="ws" onSplitStarted={() => {}} />);
    expect(await screen.findByRole("combobox", { name: "对话方式" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "对话方式" }).textContent).toContain("Agent");
    expect(screen.getByText("Agent 会直接修改这个 workspace 里的文件。")).toBeTruthy();
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
    expect(await screen.findByRole("button", { name: "终止" })).toBeTruthy();
    expect(screen.getByText("正在处理…")).toBeTruthy();
    const source = sources.at(-1);
    expect(source?.url).toBe("/api/runs/r1/events");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/log"))).toBe(false);
    source?.emit({ type: "thinking", text: "内部推理" });
    source?.emit({ type: "tool-end", callId: "c1", name: "read", detail: "a.ts" });
    const thought = (await screen.findByText("思考")).closest("details");
    const tool = screen.getByText("已使用 read").closest("details");
    expect(thought?.hasAttribute("open")).toBe(false);
    expect(tool?.hasAttribute("open")).toBe(false);
    expect(screen.getByText("内部推理")).toBeTruthy();
    source?.emit({ type: "text", text: "你" });
    source?.emit({ type: "text", text: "好" });
    expect(await screen.findByText("你好")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "终止" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/runs/r1/cancel", expect.objectContaining({ method: "POST" })),
    );
  });
});

const sessionCreatedAt = Date.parse("2026-10-01T02:04:00");

function response(url: string): Response {
  if (url.startsWith("/api/sessions?")) {
    return json([
      { id: "s1", provider: "cursor", workspace_id: "ws", workspace_name: "代码", title: null, created_at: sessionCreatedAt },
    ]);
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
    return json([
      { id: "s1", provider: "cursor", workspace_id: "ws", workspace_name: "代码", title: null, created_at: sessionCreatedAt },
    ]);
  }
  if (url.startsWith("/api/providers/")) return json([{ id: "auto", label: "Auto" }]);
  if (url === "/api/sessions/s1/runs") return json([{ id: "r1", status: "running", prompt: "在吗" }]);
  return json({});
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

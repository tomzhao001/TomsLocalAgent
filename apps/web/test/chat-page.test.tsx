import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatPage, cursorChatTitle, pinnedToBottom } from "../src/pages/Chat";

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

describe("贴底判断", () => {
  it("贴在底部、离开底部、内容还没溢出时分别给出结果", () => {
    expect(pinnedToBottom(952, 1000, 48)).toBe(true);
    expect(pinnedToBottom(900, 1000, 48)).toBe(false);
    expect(pinnedToBottom(0, 80, 200)).toBe(true);
  });
});

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
    fireEvent.pointerDown(screen.getByRole("combobox", { name: "对话方式" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    expect(screen.queryByRole("option", { name: "Plan" })).toBeNull();
    expect(screen.getByRole("option", { name: "Ask" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Agent" })).toBeTruthy();
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

  it("模型参数在弹窗里修改，放大编辑确定后写回并随消息发送", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/sessions/s1/messages" && init?.method === "POST") return json({ runId: "r2" });
      if (url.startsWith("/api/providers/")) return json([composerModel]);
      return response(url);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", class { close() {} });
    render(<ChatPage workspaceId="ws" chatModel="composer" onSplitStarted={() => {}} />);
    const summary = await screen.findByRole("button", { name: "模型" });
    expect(summary.textContent).toContain("Composer 2.5 · 200k · high · Fast");
    fireEvent.click(summary);
    fireEvent.pointerDown(screen.getByRole("combobox", { name: "上下文" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("option", { name: "1M" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByRole("button", { name: "模型" }).textContent).toContain("200k");
    fireEvent.click(screen.getByRole("button", { name: "模型" }));
    fireEvent.pointerDown(screen.getByRole("combobox", { name: "上下文" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("option", { name: "1M" }));
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(screen.getByRole("button", { name: "模型" }).textContent).toContain("Composer 2.5 · 1M · high · Fast");

    fireEvent.change(screen.getByPlaceholderText("输入消息"), { target: { value: "短" } });
    fireEvent.click(screen.getByRole("button", { name: "放大输入" }));
    fireEvent.change(screen.getByRole("textbox", { name: "放大后的消息" }), { target: { value: "不要这版" } });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect((screen.getByPlaceholderText("输入消息") as HTMLTextAreaElement).value).toBe("短");
    fireEvent.click(screen.getByRole("button", { name: "放大输入" }));
    fireEvent.change(screen.getByRole("textbox", { name: "放大后的消息" }), { target: { value: "很长的消息" } });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect((screen.getByPlaceholderText("输入消息") as HTMLTextAreaElement).value).toBe("很长的消息");

    await chooseRecent(cursorChatTitle(sessionCreatedAt));
    await waitFor(() => expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => url === "/api/sessions/s1/messages");
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        prompt: "很长的消息",
        model: "composer",
        params: [
          { id: "context", value: "1m" },
          { id: "effort", value: "high" },
          { id: "fast", value: "true" },
        ],
        mode: "agent",
      });
    });
  });
});

const sessionCreatedAt = Date.parse("2026-10-01T02:04:00");

const composerModel = {
  id: "composer",
  label: "Composer 2.5",
  parameters: [
    { id: "context", label: "上下文", values: [{ value: "200k", label: "200k" }, { value: "1m", label: "1M" }] },
    { id: "effort", label: "effort", values: [{ value: "low", label: "low" }, { value: "high", label: "high" }] },
    { id: "fast", label: "fast", values: [{ value: "false", label: "标准" }, { value: "true", label: "Fast" }] },
  ],
  variants: [
    {
      label: "默认",
      isDefault: true,
      params: [
        { id: "context", value: "200k" },
        { id: "effort", value: "high" },
        { id: "fast", value: "true" },
      ],
    },
  ],
};

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

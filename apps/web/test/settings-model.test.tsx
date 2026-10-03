import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "../src/pages/Settings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("设置页默认模型", () => {
  it("裸模型显示默认变体，确定后保存变体字符串，清空后沿用环境变量", async () => {
    let chatModel = "grok-4.7";
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/workspaces/ws" && init?.method === "PATCH") {
        chatModel = String(JSON.parse(String(init.body)).chatModel ?? "");
        return json({ ok: true });
      }
      if (url === "/api/workspaces") {
        return json([
          {
            id: "ws",
            name: "代码",
            path: "/tmp/ws",
            repos: [],
            archived: false,
            chatModel,
            developModel: "",
            reviewModel: "",
          },
        ]);
      }
      if (url === "/api/providers/cursor/models") return json([grok]);
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SettingsPage />);

    const chat = await screen.findByRole("button", { name: "聊天默认模型" });
    await waitFor(() => expect(chat.textContent).toContain("Grok 4.7 · 500k · high · Fast"));
    fireEvent.click(chat);
    fireEvent.pointerDown(screen.getByRole("combobox", { name: "上下文" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("option", { name: "256k" }));
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "本机 ~/.cursor/ 里的用户级 skills 和配置" }));
    fireEvent.click(screen.getByRole("button", { name: "保存模型" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url, init]) => url === "/api/workspaces/ws" && init?.method === "PATCH");
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
        chatModel: "grok-4.7[context=256k,reasoning_effort=low,fast=false]",
        developModel: "",
        reviewModel: "",
        cursorSettingSources: ["user"],
      });
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "聊天默认模型" }).textContent).toContain("256k"));
    fireEvent.click(screen.getByRole("button", { name: "清空聊天默认模型" }));
    fireEvent.click(screen.getByRole("button", { name: "保存模型" }));
    await waitFor(() => {
      const call = [...fetchMock.mock.calls].reverse().find(([url, init]) => url === "/api/workspaces/ws" && init?.method === "PATCH");
      expect(JSON.parse(String(call?.[1]?.body)).chatModel).toBe("");
    });
    expect(screen.getByRole("button", { name: "聊天默认模型" }).textContent).toContain("沿用环境变量");
  });
});

const grok = {
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

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

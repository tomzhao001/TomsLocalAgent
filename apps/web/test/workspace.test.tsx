import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusDot, attentionOf, sortWorkspaces } from "../src/components/WorkspaceSwitcher";
import type { Workspace, WorkspaceStatus } from "../src/lib/api";

const ws = (id: string): Workspace => ({ id, name: id, path: `/${id}`, repos: [], archived: false });
const status = (workspaceId: string, value: WorkspaceStatus["status"], drafts = 0): WorkspaceStatus => ({
  workspaceId,
  status: value,
  pending: 0,
  drafts,
  splitting: 0,
});

describe("Workspace 下拉框", () => {
  it("等待输入排最前，其次运行中，空闲在后", () => {
    const sorted = sortWorkspaces(
      [ws("idle"), ws("running"), ws("waiting"), ws("draft")],
      [status("idle", "idle"), status("running", "running"), status("waiting", "waiting_input"), status("draft", "idle", 1)],
    );
    expect(sorted.map((item) => item.id)).toEqual(["waiting", "draft", "running", "idle"]);
  });

  it("有待确认草稿也算需要处理，空闲不显示状态点", () => {
    expect(attentionOf(status("a", "idle", 2))).toBe("waiting");
    expect(attentionOf(status("a", "running"))).toBe("running");
    expect(attentionOf(undefined)).toBe("idle");
    const { container } = render(<StatusDot attention="idle" />);
    expect(container.childElementCount).toBe(0);
    render(<StatusDot attention="waiting" />);
    expect(screen.getByRole("img", { name: "等待你处理" })).toBeTruthy();
  });
});

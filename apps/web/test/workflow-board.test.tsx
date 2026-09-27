import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkflowBoard } from "../src/components/WorkflowBoard";

describe("工作流面板", () => {
  it("占用中的 workspace 显示占用者", () => {
    render(<WorkflowBoard status="running" holder="工作流 #12" />);
    expect(screen.getByRole("status").textContent).toContain("工作流 #12");
  });

  it("waiting_input 时出现介入面板", () => {
    render(<WorkflowBoard status="waiting_input" phase="arch" archRejects={4} />);
    expect(screen.getByRole("alert").textContent).toContain("等待你的输入");
  });
});

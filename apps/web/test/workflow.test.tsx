import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { groupRequirements } from "../src/components/workflow/RequirementList";
import { stepState } from "../src/components/workflow/RequirementFlow";
import { SplitTasks } from "../src/components/workflow/SplitTasks";
import { WaitForm } from "../src/components/workflow/WaitForm";
import type { Requirement, StepRun } from "../src/lib/api";

const card = { title: "登录", goal: "能登录", context: "首页", acceptanceCriteria: ["输入密码后进入首页"] };

function requirement(patch: Partial<Requirement>): Requirement {
  return {
    id: "r1",
    workspaceId: "ws",
    featureId: null,
    seq: 1,
    card,
    workflowId: "cursor-dev-loop",
    status: "running",
    phase: "develop",
    reviewRejects: 0,
    wait: null,
    createdAt: 1,
    finishedAt: null,
    steps: [],
    ...patch,
  };
}

function run(step: StepRun["step"], status: StepRun["status"], result: StepRun["result"] = null): StepRun {
  return { id: `${step}-${status}`, step, attempt: 1, status, result, note: null, startedAt: 1, endedAt: null };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const questionWait = {
  kind: "question" as const,
  fromStep: "develop" as const,
  message: "请选择存储方式",
  options: ["answer" as const, "abort" as const],
  questions: [
    {
      id: "db",
      prompt: "用 SQLite 还是 JSON？",
      options: [
        { id: "sqlite", label: "SQLite" },
        { id: "json", label: "JSON" },
      ],
    },
  ],
};

describe("被卡住时的处理弹窗", () => {
  it("选项点选后即可发送，Other 必须填写文字", async () => {
    const onSubmit = vi.fn(async () => {});
    render(<WaitForm wait={questionWait} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: "处理" }));
    expect(screen.getByText("请选择存储方式")).toBeTruthy();
    expect(screen.getByText("用 SQLite 还是 JSON？")).toBeTruthy();
    const send = screen.getByRole("button", { name: "发送" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("用 SQLite 还是 JSON？的其他回答"), { target: { value: "Postgres" } });
    expect(send.disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "SQLite" }));
    fireEvent.click(send);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("answer", "SQLite"));
    expect(await screen.findByText("已提交，将在下一次调度时继续")).toBeTruthy();
  });

  it("没有选项的旧提问仍要填写文字", async () => {
    const onSubmit = vi.fn(async () => {});
    render(
      <WaitForm
        wait={{ kind: "question", fromStep: "develop", message: "用 SQLite 还是 JSON？", options: ["answer", "abort"] }}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "处理" }));
    const send = screen.getByRole("button", { name: "发送" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("你的输入"), { target: { value: "SQLite" } });
    fireEvent.click(send);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("answer", "SQLite"));
  });

  it("超限时只显示说明和发送", async () => {
    const onSubmit = vi.fn(async () => {});
    render(
      <WaitForm
        wait={{
          kind: "limit",
          fromStep: "review",
          message: "Review 超过打回上限",
          comments: "拆分函数",
          options: ["continue", "forcePass", "abort"],
        }}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "处理" }));
    expect(screen.getByText("补充信息：拆分函数")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "强制通过" })).toBeNull();
    expect(screen.queryByRole("button", { name: "终止" })).toBeNull();
    const send = screen.getByRole("button", { name: "发送" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("你的输入"), { target: { value: "继续改拆分" } });
    fireEvent.click(send);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("continue", "继续改拆分"));
  });
});

describe("节点状态", () => {
  it("按步骤运行记录和等待信息推导", () => {
    const item = requirement({
      phase: "review",
      steps: [run("develop", "finished", { verdict: "pass", comments: "" })],
    });
    expect(stepState(item, "develop")).toBe("passed");
    expect(stepState(item, "review")).toBe("queued");
    expect(stepState(item, "devops")).toBe("idle");
    const waiting = requirement({
      status: "waiting_input",
      phase: "waiting",
      wait: { kind: "limit", fromStep: "review", message: "", options: ["abort"] },
      steps: [run("review", "finished", { verdict: "reject", comments: "补测试" })],
    });
    expect(stepState(waiting, "review")).toBe("waiting");
    expect(stepState(requirement({ steps: [run("develop", "running")] }), "develop")).toBe("running");
    expect(stepState(requirement({ phase: "devops", steps: [run("develop", "interrupted")] }), "develop")).toBe("error");
  });

  it("需求列表按大功能分组，手动添加的单独一组", () => {
    const groups = groupRequirements(
      [requirement({ id: "a", featureId: "f1" }), requirement({ id: "b", featureId: null }), requirement({ id: "c", featureId: "f1" })],
      [{ id: "f1", title: "登录", sharedContext: "", total: 3, delivered: 1 }],
    );
    expect(groups.map((group) => [group.title, group.progress, group.items.map((item) => item.id)])).toEqual([
      ["登录", "1/3", ["a", "c"]],
      ["手动添加", undefined, ["b"]],
    ]);
  });
});

describe("拆卡草稿", () => {
  it("编辑后确认，把卡片提交给确认接口", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ featureId: "f" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();
    render(
      <SplitTasks
        splits={[
          {
            id: "s1",
            chatSessionId: null,
            prompt: "做登录",
            status: "draft",
            draft: { sharedContext: "登录功能", cards: [card, { ...card, title: "多余的卡" }] },
            error: null,
            createdAt: 1,
          },
        ]}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "删除卡片" })[1]!);
    fireEvent.change(screen.getByLabelText("卡片标题"), { target: { value: "登录页" } });
    fireEvent.click(screen.getByRole("button", { name: "确认追加" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/splits/s1/confirm");
    expect(JSON.parse(String(init.body))).toEqual({
      title: "做登录",
      sharedContext: "登录功能",
      cards: [{ ...card, title: "登录页" }],
    });
  });
});

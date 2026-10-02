import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db.js";
import { WorkspaceLockManager } from "../src/locks.js";
import type { AgentRuntime, RunContext } from "../src/runs.js";
import { Dispatcher, stepModel, type RequirementRow } from "../src/workflows/_framework/dispatcher.js";
import { appendRequirements } from "../src/workflows/_framework/split-task.js";

type Script = (input: RunContext) => Promise<void> | void;

const execFileAsync = promisify(execFile);

describe("步骤模型", () => {
  const fallback = { model: "global-dev", reviewModel: "global-review" };

  it("开发和 Review 用 workspace 上的字符串，其余步骤用全局模型", () => {
    const workspace = { develop_model: "ws-dev", review_model: "ws-review" };
    expect(stepModel("develop", workspace, fallback)).toBe("ws-dev");
    expect(stepModel("review", workspace, fallback)).toBe("ws-review");
    expect(stepModel("plan", workspace, fallback)).toBe("global-dev");
    expect(stepModel("qa", workspace, fallback)).toBe("global-dev");
    expect(stepModel("devops", { develop_model: "", review_model: "" }, fallback)).toBe("global-dev");
    expect(stepModel("develop", { develop_model: "" }, fallback)).toBe("global-dev");
    expect(stepModel("review", { review_model: "" }, fallback)).toBe("global-review");
    expect(stepModel("review", { review_model: "" }, { model: "global-dev" })).toBe("global-dev");
  });
});
const card = (title: string) => ({ title, goal: "目标", context: "背景", acceptanceCriteria: ["能用"] });

function scripted(script: Script = pass) {
  const calls: RunContext[] = [];
  let agents = 0;
  const runtime: AgentRuntime = {
    async startRun(input, emit) {
      calls.push(input);
      if (!input.agentId) input.onAgent?.(`agent-${++agents}`);
      await script(input);
      emit({ type: "done", status: "finished" });
      return "finished";
    },
  };
  return { runtime, calls };
}

async function pass(input: RunContext) {
  await input.customTools?.submit_verdict?.execute({ verdict: "pass", comments: "ok" });
}

describe("Dispatcher", () => {
  let dir: string;
  let db: DatabaseSync;
  const dispatchers: Dispatcher[] = [];

  afterEach(async () => {
    for (const item of dispatchers.splice(0)) await item.stop();
    db?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function setup(runtime: AgentRuntime, cards = 2, cfg?: { reviewRejectLimit: number }, reviewModel?: string, workflowId = "cursor-dev-loop") {
    dir = await mkdtemp(join(tmpdir(), "gw-disp-"));
    db = openDatabase(join(dir, "gateway.db"));
    db.prepare(
      "INSERT INTO workspaces (id, name, path, repos_json, archived, created_at, updated_at) VALUES ('ws', 'ws', ?, '[]', 0, 1, 1)",
    ).run(dir);
    const ids = appendRequirements(
      db,
      "ws",
      null,
      Array.from({ length: cards }, (_, index) => card(`卡 ${index + 1}`)),
      Date.now(),
      workflowId,
    );
    const locks = new WorkspaceLockManager(db);
    const dispatcher = make(runtime, locks, cfg, reviewModel);
    return { ids, locks, dispatcher };
  }

  function make(runtime: AgentRuntime, locks: WorkspaceLockManager, cfg?: { reviewRejectLimit: number }, reviewModel?: string) {
    const dispatcher = new Dispatcher({ db, logDir: join(dir, "logs"), locks, runtime: () => runtime, model: "m", reviewModel, cfg, intervalMs: 0 });
    dispatchers.push(dispatcher);
    return dispatcher;
  }

  async function tick(dispatcher: Dispatcher, times = 1) {
    for (let i = 0; i < times; i++) {
      await dispatcher.tick();
      await dispatcher.idle();
    }
  }

  function row(id: string): RequirementRow {
    return db.prepare("SELECT * FROM requirements WHERE id = ?").get(id) as RequirementRow;
  }

  it("步骤结束时把工具轨迹写入 trace_json，判定仍在 result_json", async () => {
    const runtime: AgentRuntime = {
      async startRun(input, emit) {
        emit({ type: "tool-start", callId: "c1", name: "read", detail: "src/a.ts" });
        emit({ type: "tool-end", callId: "c1", name: "read", detail: "src/a.ts" });
        await pass(input);
        return "finished";
      },
    };
    const { dispatcher, ids } = await setup(runtime, 1);
    await tick(dispatcher);
    const step = db.prepare("SELECT result_json, trace_json FROM step_runs WHERE requirement_id = ?").get(ids[0]!) as {
      result_json: string;
      trace_json: string;
    };
    expect(JSON.parse(step.result_json)).toMatchObject({ verdict: "pass" });
    expect(JSON.parse(step.trace_json)).toEqual([
      { callId: "c1", name: "read", status: "running", detail: "src/a.ts" },
      { callId: "c1", name: "read", status: "completed", detail: "src/a.ts" },
    ]);
  });

  it("每次 tick 只推进一步，两张卡按顺序跑完后释放锁", async () => {
    const { runtime, calls } = scripted();
    const { ids, locks, dispatcher } = await setup(runtime);
    await tick(dispatcher);
    expect(calls.map((call) => call.access)).toEqual(["plan"]);
    expect(calls[0]!.prompt).toContain("TDD");
    expect(row(ids[1]!).status).toBe("pending");
    await tick(dispatcher, 4);
    expect(row(ids[0]!).status).toBe("delivered");
    expect(calls.map((call) => call.access)).toEqual(["plan", "develop", "review", "devops"]);
    await tick(dispatcher, 5);
    expect(row(ids[1]!).status).toBe("delivered");
    expect(locks.holder("ws", "workflow")).not.toBeNull();
    await tick(dispatcher);
    expect(locks.holder("ws", "workflow")).toBeNull();
  });

  it("开发和 DevOps 复用同一个 agent，Review 不覆盖它", async () => {
    const { runtime, calls } = scripted();
    const { dispatcher, ids } = await setup(runtime);
    await tick(dispatcher, 10);
    expect(calls.map((call) => call.agentId ?? null)).toEqual([null, "agent-1", null, "agent-1", null, "agent-3", null, "agent-3"]);
    expect(row(ids[0]!).agent_id).toBe("agent-1");
    expect(row(ids[1]!).agent_id).toBe("agent-3");
  });

  it("开发中途提问，回答后在下一次 tick 用同一个 agent 继续", async () => {
    let asked = false;
    const { runtime, calls } = scripted(async (input) => {
      if (input.access === "develop" && !asked) {
        asked = true;
        await input.customTools?.ask_user?.execute({ question: "用哪个数据库？" });
        return;
      }
      await pass(input);
    });
    const { dispatcher, ids } = await setup(runtime, 1);
    await tick(dispatcher, 3);
    const waiting = row(ids[0]!);
    expect(waiting.status).toBe("waiting_input");
    expect(JSON.parse(waiting.wait_json!)).toMatchObject({ kind: "question", fromStep: "develop", message: "用哪个数据库？" });
    await tick(dispatcher);
    expect(calls).toHaveLength(2);
    expect(dispatcher.applyInput(ids[0]!, "answer", "SQLite")).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    await tick(dispatcher);
    expect(calls[2]).toMatchObject({ access: "develop", agentId: "agent-1" });
    expect(calls[2]!.prompt).toContain("SQLite");
  });

  it("审核打回超过上限后等待输入，强制通过后进入 DevOps，打回意见带给计划", async () => {
    const { runtime, calls } = scripted(async (input) => {
      if (input.access === "review") {
        await input.customTools?.submit_verdict?.execute({ verdict: "reject", comments: "拆分函数" });
        return;
      }
      await pass(input);
    });
    const { dispatcher, ids } = await setup(runtime, 1, { reviewRejectLimit: 1 });
    await tick(dispatcher, 7);
    expect(calls[3]).toMatchObject({ access: "plan" });
    expect(calls[3]!.prompt).toContain("拆分函数");
    const waiting = row(ids[0]!);
    expect(waiting.status).toBe("waiting_input");
    expect(JSON.parse(waiting.wait_json!)).toMatchObject({ kind: "limit", fromStep: "review", comments: "拆分函数" });
    expect(dispatcher.applyInput(ids[0]!, "answer", "x")).toMatchObject({ ok: false });
    expect(dispatcher.applyInput(ids[0]!, "forcePass", "")).toEqual({ ok: true });
    await tick(dispatcher);
    expect(calls.at(-1)).toMatchObject({ access: "devops" });
  });

  it("终止一张卡后继续执行下一张", async () => {
    let first = true;
    const { runtime } = scripted(async (input) => {
      if (first) {
        first = false;
        await input.customTools?.ask_user?.execute({ question: "要不要做？" });
        return;
      }
      await pass(input);
    });
    const { dispatcher, ids } = await setup(runtime, 2);
    await tick(dispatcher, 2);
    expect(dispatcher.applyInput(ids[0]!, "abort", "")).toEqual({ ok: true });
    expect(row(ids[0]!).status).toBe("aborted");
    expect(row(ids[0]!).finished_at).not.toBeNull();
    await tick(dispatcher, 5);
    expect(row(ids[1]!).status).toBe("delivered");
  });

  it("重启后残留的运行中步骤判定为中断，用同一个 agent 重试", async () => {
    const hanging: AgentRuntime = {
      async startRun(input, _emit, signal) {
        input.onAgent?.("agent-9");
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
        return "cancelled";
      },
    };
    const { dispatcher, locks, ids } = await setup(hanging, 1);
    await dispatcher.tick();
    const { runtime, calls } = scripted();
    const restarted = make(runtime, locks);
    await tick(restarted);
    const steps = db.prepare("SELECT status FROM step_runs ORDER BY started_at, rowid").all() as { status: string }[];
    expect(steps.map((step) => step.status)).toEqual(["interrupted", "finished"]);
    expect(calls[0]).toMatchObject({ access: "plan", agentId: "agent-9" });
    expect(row(ids[0]!).status).toBe("running");
  });

  it("workflow 锁被别人占用时本次跳过", async () => {
    const { runtime, calls } = scripted();
    const { dispatcher, locks, ids } = await setup(runtime, 1);
    locks.tryAcquire("ws", "workflow", { type: "workflow", id: "someone" });
    await tick(dispatcher);
    expect(calls).toHaveLength(0);
    expect(row(ids[0]!).status).toBe("pending");
  });

  it("没有可用的 Cursor runtime 时卡片保持排队", async () => {
    const { ids, locks } = await setup(scripted().runtime, 1);
    const idle = new Dispatcher({ db, logDir: join(dir, "logs"), locks, runtime: () => null, model: "m", intervalMs: 0 });
    dispatchers.push(idle);
    await tick(idle);
    expect(row(ids[0]!).status).toBe("pending");
    expect(locks.holder("ws", "workflow")).toBeNull();
  });

  it("开发步骤把裸模型落到默认变体参数", async () => {
    const { runtime, calls } = scripted();
    runtime.listModels = async () => [
      {
        id: "grok-4.7",
        label: "Grok 4.7",
        parameters: [
          { id: "context", label: "上下文", values: [{ value: "256k", label: "256k" }, { value: "500k", label: "500k" }] },
          { id: "reasoning_effort", label: "推理", values: [{ value: "low", label: "low" }, { value: "high", label: "high" }] },
        ],
        variants: [
          {
            label: "默认",
            isDefault: true,
            params: [
              { id: "context", value: "500k" },
              { id: "reasoning_effort", value: "high" },
            ],
          },
        ],
      },
    ];
    const { dispatcher } = await setup(runtime, 1);
    db.prepare("UPDATE workspaces SET develop_model = ? WHERE id = 'ws'").run("grok-4.7");
    await tick(dispatcher, 2);
    expect(calls[1]).toMatchObject({
      access: "develop",
      model: "grok-4.7",
      modelParams: [
        { id: "context", value: "500k" },
        { id: "reasoning_effort", value: "high" },
      ],
    });
  });

  it("Review 使用单独模型，prompt 带验收标准和 diff，且不覆盖开发 agent", async () => {
    const { runtime, calls } = scripted();
    const { dispatcher, ids } = await setup(runtime, 1, undefined, "expensive");
    await writeFile(join(dir, ".gitignore"), "gateway.db\nlogs/\n");
    await execFileAsync("git", ["init"], { cwd: dir, windowsHide: true });
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "hello.ts"), "export const hello = 'from-diff';\n");
    await tick(dispatcher, 3);
    expect(calls[0]).toMatchObject({ access: "plan" });
    expect(calls[1]).toMatchObject({ access: "develop", agentId: "agent-1" });
    expect(calls[2]).toMatchObject({ access: "review", model: "expensive", agentId: null });
    expect(calls[2]!.prompt).toContain("能用");
    expect(calls[2]!.prompt).toContain("from-diff");
    expect(row(ids[0]!).agent_id).toBe("agent-1");
  });

  it("Review 打回没有意见时不回到开发", async () => {
    const { runtime, calls } = scripted(async (input) => {
      if (input.access === "review") {
        const result = await input.customTools?.submit_verdict?.execute({ verdict: "reject", comments: "   " });
        expect(result).toMatchObject({ isError: true });
        return;
      }
      await pass(input);
    });
    const { dispatcher } = await setup(runtime, 1);
    await tick(dispatcher, 4);
    expect(calls.map((call) => call.access)).toEqual(["plan", "develop", "review", "review"]);
  });

  it("QA 卡只跑 QA，失败后重试仍是 QA，通过后结束", async () => {
    let passed = false;
    const { runtime, calls } = scripted(async (input) => {
      if (!passed) {
        passed = true;
        await input.customTools?.submit_verdict?.execute({ verdict: "reject", comments: "登录失败" });
        return;
      }
      await pass(input);
    });
    const { dispatcher, ids } = await setup(runtime, 1, undefined, undefined, "cursor-qa");
    await tick(dispatcher, 2);
    expect(calls.map((call) => call.access)).toEqual(["qa"]);
    expect(row(ids[0]!).status).toBe("waiting_input");
    expect(JSON.parse(row(ids[0]!).wait_json!)).toMatchObject({ kind: "qaFailed", fromStep: "qa", comments: "登录失败" });
    expect(dispatcher.applyInput(ids[0]!, "answer", "再跑")).toEqual({ ok: true });
    await tick(dispatcher, 2);
    expect(calls.map((call) => call.access)).toEqual(["qa", "qa"]);
    expect(row(ids[0]!).status).toBe("delivered");
    expect(calls.some((call) => call.access === "devops")).toBe(false);
  });

  it("没有提交结果算技术错误，连续两次进入等待输入", async () => {
    const { runtime, calls } = scripted(() => {});
    const { dispatcher, ids } = await setup(runtime, 1);
    await tick(dispatcher, 3);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(row(ids[0]!).wait_json!)).toMatchObject({ kind: "techError", fromStep: "plan" });
  });
});

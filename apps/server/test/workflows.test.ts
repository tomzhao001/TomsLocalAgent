import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { AgentRuntime, GatewayToolResult } from "../src/runs.js";

const password = "correct-horse";
const card = (title: string) => ({ title, goal: "目标", context: "背景", acceptanceCriteria: ["能用"] });

describe("工作流接口", () => {
  let app: FastifyInstance;
  let dir: string;
  let cookie: string;

  beforeAll(() => {
    process.env.FAKE_DELAY_MS = "1";
  });

  afterEach(async () => {
    await app?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function start(runtimes?: Partial<Record<string, AgentRuntime>>) {
    dir = await mkdtemp(join(tmpdir(), "gw-wf-"));
    const root = join(dir, "root");
    await mkdir(join(root, "repo"), { recursive: true });
    app = await buildApp({
      dbPath: join(dir, "gateway.db"),
      adminPassword: password,
      cookieSecure: true,
      workspaceRoots: [root],
      logDir: join(dir, "logs"),
      agentRuntime: runtimes ? undefined : "fake",
      runtimes,
      dispatchIntervalMs: 0,
    });
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { password } });
    cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";
    const ws = await authed("POST", "/api/workspaces", { name: "代码", path: join(root, "repo") });
    return ws.json().id as string;
  }

  function authed(method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) {
    return app.inject({ method, url, headers: { cookie }, payload });
  }

  async function tick(times = 1) {
    for (let i = 0; i < times; i++) {
      await app.dispatcher!.tick();
      await app.dispatcher!.idle();
    }
  }

  async function waitSplit(id: string, status: string) {
    await app.splits!.idle();
    const row = app.splits!.load(id);
    expect(row?.status).toBe(status);
    return row!;
  }

  it("手动新增的卡进入队列，只能删除还没开始的卡", async () => {
    const ws = await start();
    const bad = await authed("POST", `/api/workspaces/${ws}/requirements`, { title: "缺字段" });
    expect(bad.statusCode).toBe(400);
    const first = await authed("POST", `/api/workspaces/${ws}/requirements`, card("第一张"));
    const second = await authed("POST", `/api/workspaces/${ws}/requirements`, card("第二张"));
    expect(first.statusCode).toBe(201);
    const active = (await authed("GET", `/api/workspaces/${ws}/requirements?scope=active`)).json();
    expect(active.items.map((item: { card: { title: string } }) => item.card.title)).toEqual(["第一张", "第二张"]);
    const status = (await authed("GET", "/api/workflow/status")).json();
    expect(status).toEqual([expect.objectContaining({ workspaceId: ws, status: "running", pending: 2 })]);

    await tick();
    expect((await authed("DELETE", `/api/requirements/${first.json().id}`)).statusCode).toBe(409);
    expect((await authed("DELETE", `/api/requirements/${second.json().id}`)).statusCode).toBe(204);
  });

  it("跑完的卡出现在已完成列表，详情里带各步骤和日志", async () => {
    const ws = await start();
    const created = await authed("POST", `/api/workspaces/${ws}/requirements`, card("交付我"));
    await tick(5);
    const active = (await authed("GET", `/api/workspaces/${ws}/requirements?scope=active`)).json();
    expect(active.items).toEqual([]);
    const history = (await authed("GET", `/api/workspaces/${ws}/requirements?scope=history`)).json();
    expect(history).toMatchObject({ hasMore: false, items: [{ id: created.json().id, status: "delivered" }] });
    const detail = (await authed("GET", `/api/requirements/${created.json().id}`)).json();
    expect(detail.steps.map((step: { step: string }) => step.step)).toEqual(["plan", "develop", "review", "devops"]);
    expect(detail.workflowId).toBe("cursor-dev-loop");
    const log = (await authed("GET", `/api/step-runs/${detail.steps[0].id}/log?offset=0`)).json();
    expect(log.status).toBe("finished");
    expect(log.events.at(-1)).toEqual({ type: "done", status: "finished" });
  });

  it("手动新增可以选择 QA 工作流，通过后只有 QA 步骤", async () => {
    const ws = await start();
    const created = await authed("POST", `/api/workspaces/${ws}/requirements`, { ...card("只测"), workflow: "cursor-qa" });
    expect(created.statusCode).toBe(201);
    expect(created.json().workflowId).toBe("cursor-qa");
    await tick(2);
    const detail = (await authed("GET", `/api/requirements/${created.json().id}`)).json();
    expect(detail).toMatchObject({ status: "delivered", workflowId: "cursor-qa" });
    expect(detail.steps.map((step: { step: string }) => step.step)).toEqual(["qa"]);
  });

  it("等待输入时提交回答，非法操作返回 409", async () => {
    let asked = false;
    const runtime: AgentRuntime = {
      async startRun(input, emit) {
        if (!asked) {
          asked = true;
          await input.customTools?.ask_user?.execute({ question: "要加缓存吗？" });
        } else {
          await input.customTools?.submit_verdict?.execute({ verdict: "pass", comments: "ok" });
        }
        emit({ type: "done", status: "finished" });
        return "finished";
      },
    };
    const ws = await start({ cursor: runtime });
    const created = await authed("POST", `/api/workspaces/${ws}/requirements`, card("问我"));
    const id = created.json().id as string;
    await tick(2);
    const waiting = (await authed("GET", `/api/requirements/${id}`)).json();
    expect(waiting).toMatchObject({ status: "waiting_input", wait: { kind: "question", message: "要加缓存吗？" } });
    expect((await authed("GET", "/api/workflow/status")).json()[0].status).toBe("waiting_input");
    expect((await authed("POST", `/api/requirements/${id}/input`, { action: "answer" })).statusCode).toBe(400);
    expect((await authed("POST", `/api/requirements/${id}/input`, { action: "forcePass" })).statusCode).toBe(409);
    const answered = await authed("POST", `/api/requirements/${id}/input`, { action: "answer", text: "要" });
    expect(answered.json()).toMatchObject({ status: "running", phase: "plan" });
  });

  it("拆卡生成草稿，确认后按顺序追加到队尾", async () => {
    const ws = await start();
    await authed("POST", `/api/workspaces/${ws}/requirements`, card("已有的卡"));
    const started = await authed("POST", `/api/workspaces/${ws}/splits`, { prompt: "做一个登录页" });
    expect(started.statusCode).toBe(202);
    const split = await waitSplit(started.json().id, "draft");
    expect(JSON.parse(split.draft_json!).cards).toHaveLength(1);
    const listed = (await authed("GET", `/api/workspaces/${ws}/splits`)).json();
    expect(listed).toEqual([expect.objectContaining({ id: split.id, status: "draft" })]);

    const invalid = await authed("POST", `/api/splits/${split.id}/confirm`, { sharedContext: "x", cards: [] });
    expect(invalid.statusCode).toBe(400);
    const confirmed = await authed("POST", `/api/splits/${split.id}/confirm`, {
      title: "登录",
      sharedContext: "登录功能",
      cards: [card("登录表单"), card("登录接口")],
    });
    expect(confirmed.statusCode).toBe(200);
    const active = (await authed("GET", `/api/workspaces/${ws}/requirements?scope=active`)).json();
    expect(active.items.map((item: { card: { title: string } }) => item.card.title)).toEqual(["已有的卡", "登录表单", "登录接口"]);
    expect(active.features).toEqual([expect.objectContaining({ title: "登录", total: 2, delivered: 0 })]);
    expect((await authed("POST", `/api/splits/${split.id}/confirm`, { sharedContext: "x", cards: [card("再来")] })).statusCode).toBe(409);
  });

  it("拆卡用独立的只读 agent，校验失败的结果会返回给模型", async () => {
    const results: GatewayToolResult[] = [];
    const seen: { access?: string; agentId?: string | null; prompt: string }[] = [];
    const runtime: AgentRuntime = {
      async startRun(input, emit) {
        seen.push({ access: input.access, agentId: input.agentId, prompt: input.prompt });
        input.onAgent?.("split-agent");
        const tool = input.customTools!.submit_requirements!;
        results.push(await tool.execute({ sharedContext: "背景", cards: [{ title: "缺字段" }] }));
        results.push(await tool.execute({ sharedContext: "背景", cards: [card("好卡")] }));
        emit({ type: "done", status: "finished" });
        return "finished";
      },
    };
    const ws = await start({ cursor: runtime });
    const chat = await authed("POST", "/api/sessions", { provider: "cursor", workspaceId: ws });
    const started = await authed("POST", `/api/workspaces/${ws}/splits`, { prompt: "拆一下", chatSessionId: chat.json().id });
    const split = await waitSplit(started.json().id, "draft");
    expect(seen).toEqual([{ access: "split", agentId: null, prompt: expect.stringContaining("拆一下") }]);
    expect(results[0]).toMatchObject({ isError: true });
    expect(typeof results[1]).toBe("string");
    expect(split.agent_id).toBe("split-agent");
    const log = (await authed("GET", `/api/splits/${split.id}/log?offset=0`)).json();
    expect(log.status).toBe("draft");
  });

  it("同一个 workspace 同时只能有一个拆卡，没交卡的拆卡标记失败", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime: AgentRuntime = {
      async startRun(_input, emit) {
        await gate;
        emit({ type: "done", status: "finished" });
        return "finished";
      },
    };
    const ws = await start({ cursor: runtime });
    const first = await authed("POST", `/api/workspaces/${ws}/splits`, { prompt: "一" });
    expect(first.statusCode).toBe(202);
    const second = await authed("POST", `/api/workspaces/${ws}/splits`, { prompt: "二" });
    expect(second.statusCode).toBe(409);
    release();
    const failed = await waitSplit(first.json().id, "failed");
    expect(failed.error).toContain("没有提交需求卡");
    expect((await authed("POST", `/api/splits/${failed.id}/discard`)).statusCode).toBe(200);
    expect((await authed("GET", `/api/workspaces/${ws}/splits`)).json()).toEqual([]);
  });
});

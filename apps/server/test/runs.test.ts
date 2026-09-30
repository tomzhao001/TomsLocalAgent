import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { readLog, logFile } from "../src/logs.js";
import { WorkspaceLockManager } from "../src/locks.js";
import { interruptedReply, type AgentRuntime } from "../src/runs.js";

const password = "correct-horse";

function cookieOf(setCookie: string | string[] | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!raw) throw new Error("missing set-cookie");
  return raw.split(";")[0] ?? "";
}

async function waitFor<T>(load: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 50; i++) {
    const value = await load();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out");
}

describe("运行、日志与锁", () => {
  let app: FastifyInstance;
  let dir: string;
  let cookie: string;

  afterEach(async () => {
    await app?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function start() {
    dir = await mkdtemp(join(tmpdir(), "gw-run-"));
    const root = join(dir, "root");
    await mkdir(join(root, "one"), { recursive: true });
    app = await buildApp({
      dbPath: join(dir, "gateway.db"),
      adminPassword: password,
      cookieSecure: true,
      workspaceRoots: [root],
      logDir: join(dir, "logs"),
      agentRuntime: "fake",
    });
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { password } });
    cookie = cookieOf(login.headers["set-cookie"]);
    return root;
  }

  function authed(method: "GET" | "POST", url: string, payload?: unknown) {
    return app.inject({ method, url, headers: { cookie }, payload });
  }

  async function session(root: string, name: string) {
    const folder = join(root, name);
    await mkdir(folder, { recursive: true });
    const workspace = await authed("POST", "/api/workspaces", { name, path: folder });
    expect(workspace.statusCode).toBe(201);
    const created = await authed("POST", "/api/sessions", {
      provider: "cursor",
      workspaceId: workspace.json().id,
    });
    expect(created.statusCode).toBe(201);
    return { sessionId: created.json().id as string, workspaceId: workspace.json().id as string };
  }

  it("请求返回后假 Provider 仍把后续事件写进日志", async () => {
    const root = await start();
    const { sessionId } = await session(root, "alpha");
    const sent = await authed("POST", `/api/sessions/${sessionId}/messages`, { prompt: "你好", model: "fake" });
    expect(sent.statusCode).toBe(202);
    const runId = sent.json().runId as string;
    const runs = await authed("GET", `/api/sessions/${sessionId}/runs`);
    expect(runs.json()).toEqual([expect.objectContaining({ id: runId, prompt: "你好" })]);
    const early = await authed("GET", `/api/runs/${runId}/log?offset=0`);
    expect(early.json().events).toEqual([]);

    const done = await waitFor(
      async () => (await authed("GET", `/api/runs/${runId}/log?offset=0`)).json(),
      (body) => body.status === "finished",
    );
    expect(done.events).toEqual([
      { type: "text", text: "你好" },
      { type: "done", status: "finished" },
    ]);
  });

  it("SSE 推出文本，结束后按序号补看归档", async () => {
    const root = await start();
    const { sessionId } = await session(root, "stream");
    const sent = await authed("POST", `/api/sessions/${sessionId}/messages`, { prompt: "你好", model: "fake" });
    const runId = sent.json().runId as string;
    const live = await authed("GET", `/api/runs/${runId}/events`);
    expect(live.statusCode).toBe(200);
    expect(String(live.headers["content-type"])).toContain("text/event-stream");
    expect(live.body).toContain('"text":"你好"');
    const again = await authed("GET", `/api/runs/${runId}/events?after=1`);
    expect(again.body).not.toContain("你好");
    expect(again.body).toContain('"type":"done"');
  });

  it("断开 SSE 不会取消这次运行", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime: AgentRuntime = {
      async startRun(_input, emit, signal) {
        await gate;
        if (signal?.aborted) return "cancelled";
        emit({ type: "text", text: "还在" });
        emit({ type: "done", status: "finished" });
        return "finished";
      },
    };
    dir = await mkdtemp(join(tmpdir(), "gw-run-"));
    const root = join(dir, "root");
    await mkdir(join(root, "one"), { recursive: true });
    app = await buildApp({
      dbPath: join(dir, "gateway.db"),
      adminPassword: password,
      cookieSecure: true,
      workspaceRoots: [root],
      logDir: join(dir, "logs"),
      runtime,
    });
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { password } });
    cookie = cookieOf(login.headers["set-cookie"]);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const { sessionId } = await session(root, "detach");
    const sent = await authed("POST", `/api/sessions/${sessionId}/messages`, { prompt: "先别停", model: "m" });
    const runId = sent.json().runId as string;
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        { hostname: "127.0.0.1", port, path: `/api/runs/${runId}/events`, headers: { cookie } },
        (res) => {
          res.once("data", () => {
            req.destroy();
            resolve();
          });
        },
      );
      req.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNRESET") resolve();
        else reject(error);
      });
      req.end();
    });
    release();
    const done = await waitFor(
      async () => (await authed("GET", `/api/runs/${runId}/log?offset=0`)).json(),
      (body) => body.status === "finished",
    );
    expect(done.events).toEqual([
      { type: "text", text: "还在" },
      { type: "done", status: "finished" },
    ]);
  });

  it("重启后中断仍在跑的聊天，并放开锁", async () => {
    const root = await start();
    const { sessionId, workspaceId } = await session(root, "stuck");
    await app.close();
    const db = new DatabaseSync(join(dir, "gateway.db"));
    db.prepare("INSERT INTO runs (id, workspace_id, session_id, status, created_at) VALUES ('stuck', ?, ?, 'running', 1)").run(
      workspaceId,
      sessionId,
    );
    db.prepare(
      "INSERT INTO workspace_locks (workspace_id, kind, holder_type, holder_id, acquired_at) VALUES (?, 'chat', 'run', 'stuck', 1)",
    ).run(workspaceId);
    db.close();

    app = await buildApp({
      dbPath: join(dir, "gateway.db"),
      adminPassword: password,
      cookieSecure: true,
      workspaceRoots: [root],
      logDir: join(dir, "logs"),
      agentRuntime: "fake",
    });
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { password } });
    cookie = cookieOf(login.headers["set-cookie"]);
    const archived = readLog(logFile(join(dir, "logs"), sessionId, "stuck"), 0);
    expect(archived.events).toEqual([{ type: "error", message: interruptedReply }]);
    const sent = await authed("POST", `/api/sessions/${sessionId}/messages`, { prompt: "继续", model: "fake" });
    expect(sent.statusCode).toBe(202);
  });

  it("聊天列表可以按 workspace 过滤", async () => {
    const root = await start();
    const one = await session(root, "one-ws");
    await session(root, "two-ws");
    const filtered = await authed("GET", `/api/sessions?workspaceId=${one.workspaceId}`);
    expect(filtered.json().map((item: { id: string }) => item.id)).toEqual([one.sessionId]);
    expect((await authed("GET", "/api/sessions")).json()).toHaveLength(2);
  });

  it("同一个 workspace 上并发的第二次运行返回 409", async () => {
    const root = await start();
    const first = await session(root, "shared");
    const second = await authed("POST", "/api/sessions", { provider: "opencode", workspaceId: first.workspaceId });
    const running = await authed("POST", `/api/sessions/${first.sessionId}/messages`, { prompt: "占着", model: "fake" });
    expect(running.statusCode).toBe(202);
    const blocked = await authed("POST", `/api/sessions/${second.json().id}/messages`, { prompt: "再来", model: "fake" });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().holder.id).toBe(running.json().runId);
  });

  it("进程重启后清掉持有者已结束的锁", async () => {
    const root = await start();
    const { workspaceId } = await session(root, "stale");
    await app.close();
    const db = new DatabaseSync(join(dir, "gateway.db"));
    db.prepare("INSERT INTO runs (id, workspace_id, status, created_at) VALUES ('old', ?, 'finished', 1)").run(workspaceId);
    db.prepare(
      "INSERT INTO workspace_locks (workspace_id, holder_type, holder_id, acquired_at) VALUES (?, 'run', 'old', 1)",
    ).run(workspaceId);
    db.close();

    app = await buildApp({
      dbPath: join(dir, "gateway.db"),
      adminPassword: password,
      cookieSecure: true,
      workspaceRoots: [root],
      logDir: join(dir, "logs"),
      agentRuntime: "fake",
    });
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { password } });
    cookie = cookieOf(login.headers["set-cookie"]);
    const created = await authed("POST", "/api/sessions", { provider: "cursor", workspaceId });
    const sent = await authed("POST", `/api/sessions/${created.json().id}/messages`, { prompt: "继续", model: "fake" });
    expect(sent.statusCode).toBe(202);
  });
});

describe("openDatabase locks table", () => {
  it("包含 workspace_locks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gw-lock-"));
    const db = openDatabase(join(dir, "gateway.db"));
    const row = db.prepare("SELECT name FROM sqlite_master WHERE name = 'workspace_locks'").get();
    expect(row).toBeTruthy();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("聊天锁和工作流锁互不阻塞，同一种锁互斥", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gw-lock-"));
    const db = openDatabase(join(dir, "gateway.db"));
    const locks = new WorkspaceLockManager(db);
    expect(locks.tryAcquire("ws", "chat", { type: "run", id: "r1" }).ok).toBe(true);
    expect(locks.tryAcquire("ws", "workflow", { type: "workflow", id: "ws" }).ok).toBe(true);
    const blocked = locks.tryAcquire("ws", "chat", { type: "run", id: "r2" });
    expect(blocked).toEqual({ ok: false, holder: { type: "run", id: "r1" } });
    expect(locks.tryAcquire("ws", "workflow", { type: "workflow", id: "ws" }).ok).toBe(true);
    expect(locks.tryAcquire("ws", "workflow", { type: "workflow", id: "other" }).ok).toBe(false);
    locks.release("ws", "chat", "r1");
    expect(locks.tryAcquire("ws", "chat", { type: "run", id: "r2" }).ok).toBe(true);
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("旧版锁表没有 kind 列时重建", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gw-lock-"));
    const file = join(dir, "gateway.db");
    const legacy = new DatabaseSync(file);
    legacy.exec(
      "CREATE TABLE workspace_locks (workspace_id TEXT PRIMARY KEY, holder_type TEXT NOT NULL, holder_id TEXT NOT NULL, acquired_at INTEGER NOT NULL)",
    );
    legacy.close();
    const db = openDatabase(file);
    const columns = db.prepare("PRAGMA table_info(workspace_locks)").all() as { name: string }[];
    expect(columns.map((item) => item.name)).toContain("kind");
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
});

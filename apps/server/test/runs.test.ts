import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";

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
});

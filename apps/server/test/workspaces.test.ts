import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
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

describe("workspace", () => {
  let app: FastifyInstance;
  let dir: string;
  let cookie: string;

  afterEach(async () => {
    await app?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function start(extra?: { pickDirectory?: () => Promise<string | null> }) {
    dir = await mkdtemp(join(tmpdir(), "gw-ws-"));
    const root = join(dir, "root");
    await mkdir(root, { recursive: true });
    app = await buildApp({
      dbPath: join(dir, "gateway.db"),
      adminPassword: password,
      cookieSecure: true,
      workspaceRoots: [root],
      pickDirectory: extra?.pickDirectory,
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password },
    });
    cookie = cookieOf(login.headers["set-cookie"]);
    return root;
  }

  function authed(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      headers: { cookie },
      payload,
    });
  }

  it("允许添加任意已存在的目录", async () => {
    await start();
    const outside = join(dir, "outside");
    await mkdir(outside);
    const res = await authed("POST", "/api/workspaces", { name: "任意", path: outside });
    expect(res.statusCode).toBe(201);
    expect(res.json().path).toBe(realpathSync(outside));
  });

  it("拒绝不存在的路径", async () => {
    await start();
    const res = await authed("POST", "/api/workspaces", { name: "无", path: join(dir, "missing") });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/已存在的目录/);
  });

  it("浏览目录返回所选路径，取消时不填路径", async () => {
    let chosenPath: string | null = null;
    await start({ pickDirectory: async () => chosenPath });
    const picked = join(dir, "picked");
    await mkdir(picked);
    chosenPath = picked;
    const chosen = await authed("POST", "/api/workspaces/browse");
    expect(chosen.statusCode).toBe(200);
    expect(chosen.json().path).toBe(realpathSync(picked));

    chosenPath = null;
    const cancelled = await authed("POST", "/api/workspaces/browse");
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toEqual({ path: null });
  });

  it("拒绝相互包含的路径", async () => {
    const root = await start();
    const parent = join(root, "parent");
    const child = join(parent, "child");
    await mkdir(child, { recursive: true });
    const first = await authed("POST", "/api/workspaces", { name: "父", path: parent });
    expect(first.statusCode).toBe(201);
    const second = await authed("POST", "/api/workspaces", { name: "子", path: child });
    expect(second.statusCode).toBe(409);
    expect(second.json().message).toMatch(/重叠/);
  });

  it("符号链接会先规范化，因此和真实目录视为同一路径", async () => {
    const root = await start();
    const real = join(root, "real");
    const link = join(root, "link");
    await mkdir(real);
    await symlink(real, link, process.platform === "win32" ? "junction" : "dir");
    const first = await authed("POST", "/api/workspaces", { name: "真实", path: real });
    expect(first.statusCode).toBe(201);
    const second = await authed("POST", "/api/workspaces", { name: "链接", path: link });
    expect(second.statusCode).toBe(409);
    expect(second.json().message).toMatch(/重叠/);
  });

  it("已被聊天引用时不能修改路径，只能改名称", async () => {
    const root = await start();
    const path = join(root, "app");
    const other = join(root, "other");
    await mkdir(path);
    await mkdir(other);
    const created = await authed("POST", "/api/workspaces", { name: "主站", path });
    const id = created.json().id as string;
    const session = await authed("POST", "/api/sessions", {
      provider: "cursor",
      workspaceId: id,
      title: "讨论",
    });
    expect(session.statusCode).toBe(201);
    const renamed = await authed("PATCH", `/api/workspaces/${id}`, { name: "主站改名" });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().name).toBe("主站改名");
    const moved = await authed("PATCH", `/api/workspaces/${id}`, { path: other });
    expect(moved.statusCode).toBe(409);
  });

  it("数据库触发器拒绝修改 chat_sessions.workspace_id", async () => {
    const root = await start();
    const a = join(root, "a");
    const b = join(root, "b");
    await mkdir(a);
    await mkdir(b);
    const first = await authed("POST", "/api/workspaces", { name: "A", path: a });
    const second = await authed("POST", "/api/workspaces", { name: "B", path: b });
    const session = await authed("POST", "/api/sessions", {
      provider: "cursor",
      workspaceId: first.json().id,
    });
    const db = new DatabaseSync(join(dir, "gateway.db"));
    expect(() => {
      db.prepare("UPDATE chat_sessions SET workspace_id = ? WHERE id = ?").run(
        second.json().id,
        session.json().id,
      );
    }).toThrow(/immutable/i);
    db.close();
  });

  it("扫描出多个 Git 仓库，超过深度的不算", async () => {
    const root = await start();
    const ws = join(root, "ws");
    await mkdir(join(ws, "repo-a", ".git"), { recursive: true });
    await mkdir(join(ws, "nested", "repo-b", ".git"), { recursive: true });
    await mkdir(join(ws, "l1", "l2", "l3", "too-deep", ".git"), { recursive: true });
    const created = await authed("POST", "/api/workspaces", { name: "多仓库", path: ws });
    expect(created.statusCode).toBe(201);
    const repos = created.json().repos as string[];
    expect(repos).toEqual(expect.arrayContaining([join(ws, "repo-a"), join(ws, "nested", "repo-b")]));
    expect(repos.some((repo) => repo.includes("too-deep"))).toBe(false);
  });

  it("无引用可删除，有引用只能归档，运行中不能归档", async () => {
    const root = await start();
    const free = join(root, "free");
    const used = join(root, "used");
    const busy = join(root, "busy");
    await mkdir(free);
    await mkdir(used);
    await mkdir(busy);
    const freeWs = await authed("POST", "/api/workspaces", { name: "空", path: free });
    const usedWs = await authed("POST", "/api/workspaces", { name: "占用", path: used });
    const busyWs = await authed("POST", "/api/workspaces", { name: "运行", path: busy });
    await authed("POST", "/api/sessions", { provider: "opencode", workspaceId: usedWs.json().id });

    const removed = await authed("DELETE", `/api/workspaces/${freeWs.json().id}`);
    expect(removed.statusCode).toBe(204);

    const blocked = await authed("DELETE", `/api/workspaces/${usedWs.json().id}`);
    expect(blocked.statusCode).toBe(409);
    const archived = await authed("POST", `/api/workspaces/${usedWs.json().id}/archive`);
    expect(archived.statusCode).toBe(200);
    expect(archived.json().archived).toBe(true);

    const db = new DatabaseSync(join(dir, "gateway.db"));
    db.prepare(
      "INSERT INTO runs (id, workspace_id, status, created_at) VALUES (?, ?, 'running', ?)",
    ).run("run-1", busyWs.json().id, Date.now());
    db.close();
    const cannot = await authed("POST", `/api/workspaces/${busyWs.json().id}/archive`);
    expect(cannot.statusCode).toBe(409);
  });
});

describe("openDatabase", () => {
  it("可以打开临时库", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gw-db-"));
    const db = openDatabase(join(dir, "gateway.db"));
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
});

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

const exec = promisify(execFile);
const password = "correct-horse";

function cookieOf(setCookie: string | string[] | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!raw) throw new Error("missing set-cookie");
  return raw.split(";")[0] ?? "";
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await exec("git", args, { cwd, windowsHide: true, encoding: "utf8" });
    return result.stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || (error as Error).message);
  }
}

async function initRepo(repo: string) {
  await mkdir(repo, { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await git(repo, ["config", "core.autocrlf", "false"]);
}

async function commit(repo: string, name: string, content: string, message: string) {
  await writeFile(join(repo, name), content);
  await git(repo, ["add", name]);
  await git(repo, ["commit", "-m", message]);
}

type RepoState = {
  path: string;
  name: string;
  branch: string;
  detached: boolean;
  dirty: boolean;
  branches: { name: string; remote: boolean }[];
  error?: string;
};

describe("git 分支", () => {
  let app: FastifyInstance;
  let dir: string;
  let cookie: string;

  afterEach(async () => {
    await app?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function start() {
    dir = await mkdtemp(join(tmpdir(), "gw-git-"));
    const root = join(dir, "root");
    await mkdir(root, { recursive: true });
    app = await buildApp({
      dbPath: join(dir, "gateway.db"),
      adminPassword: password,
      cookieSecure: true,
      workspaceRoots: [root],
      dispatchIntervalMs: 60_000,
    });
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { password } });
    cookie = cookieOf(login.headers["set-cookie"]);
    return root;
  }

  function authed(method: "GET" | "POST", url: string, payload?: unknown) {
    return app.inject({ method, url, headers: { cookie }, payload });
  }

  async function workspace(root: string, name = "应用") {
    const created = await authed("POST", "/api/workspaces", { name, path: root });
    expect(created.statusCode).toBe(201);
    return created.json() as { id: string; repos: string[] };
  }

  async function listed(id: string): Promise<RepoState[]> {
    const res = await authed("GET", `/api/workspaces/${id}/git`);
    expect(res.statusCode).toBe(200);
    return res.json().repos as RepoState[];
  }

  it("列出本地分支和 origin 远程分支", async () => {
    const root = await start();
    const origin = join(dir, "origin.git");
    const repo = join(root, "app");
    await git(dir, ["init", "--bare", "-b", "main", origin]);
    await initRepo(repo);
    await commit(repo, "notes.txt", "base\n", "init");
    await git(repo, ["remote", "add", "origin", origin]);
    await git(repo, ["push", "-u", "origin", "main"]);
    await git(repo, ["switch", "-c", "feature"]);
    await commit(repo, "notes.txt", "feature-content\n", "feature");
    await git(repo, ["push", "-u", "origin", "feature"]);
    await git(repo, ["switch", "main"]);
    const ws = await workspace(root);

    const repos = await listed(ws.id);
    const app = repos.find((item) => item.name === "app");
    expect(app).toMatchObject({ branch: "main", detached: false, dirty: false });
    expect(app?.branches).toEqual(expect.arrayContaining([
      { name: "main", remote: false },
      { name: "feature", remote: false },
      { name: "origin/main", remote: true },
      { name: "origin/feature", remote: true },
    ]));

    const switched = await authed("POST", `/api/workspaces/${ws.id}/git/switch`, {
      path: app?.path,
      branch: "origin/feature",
    });
    expect(switched.statusCode).toBe(200);
    expect(switched.json()).toMatchObject({ branch: "feature", detached: false });
  });

  it("干净的仓库可以切到本地分支", async () => {
    const root = await start();
    const repo = join(root, "app");
    await initRepo(repo);
    await commit(repo, "notes.txt", "base\n", "init");
    await git(repo, ["switch", "-c", "feature"]);
    await git(repo, ["switch", "main"]);
    const ws = await workspace(root);
    const app = (await listed(ws.id)).find((item) => item.name === "app");

    const switched = await authed("POST", `/api/workspaces/${ws.id}/git/switch`, {
      path: app?.path,
      branch: "feature",
    });
    expect(switched.statusCode).toBe(200);
    expect(switched.json()).toMatchObject({ branch: "feature", dirty: false });
    expect((await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("feature");
  });

  it("有未提交改动时不带 stash 会拒绝，并留在原分支", async () => {
    const root = await start();
    const repo = join(root, "app");
    await initRepo(repo);
    await commit(repo, "notes.txt", "base\n", "init");
    await git(repo, ["switch", "-c", "feature"]);
    await git(repo, ["switch", "main"]);
    await writeFile(join(repo, "notes.txt"), "dirty-local\n");
    const ws = await workspace(root);
    const app = (await listed(ws.id)).find((item) => item.name === "app");
    expect(app?.dirty).toBe(true);

    const denied = await authed("POST", `/api/workspaces/${ws.id}/git/switch`, {
      path: app?.path,
      branch: "feature",
    });
    expect(denied.statusCode).toBe(409);
    expect(denied.json()).toMatchObject({ error: "dirty" });
    expect((await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("main");
    expect(await readFile(join(repo, "notes.txt"), "utf8")).toBe("dirty-local\n");
  });

  it("确认 stash 后切换，改动进入 stash 而不会带到新分支", async () => {
    const root = await start();
    const repo = join(root, "app");
    await initRepo(repo);
    await commit(repo, "notes.txt", "base\n", "init");
    await git(repo, ["switch", "-c", "feature"]);
    await commit(repo, "notes.txt", "feature-content\n", "feature");
    await git(repo, ["switch", "main"]);
    await writeFile(join(repo, "notes.txt"), "dirty-local\n");
    await writeFile(join(repo, "scratch.txt"), "untracked\n");
    const ws = await workspace(root);
    const app = (await listed(ws.id)).find((item) => item.name === "app");

    const switched = await authed("POST", `/api/workspaces/${ws.id}/git/switch`, {
      path: app?.path,
      branch: "feature",
      stash: true,
    });
    expect(switched.statusCode).toBe(200);
    expect(switched.json()).toMatchObject({ branch: "feature", dirty: false });
    expect(await readFile(join(repo, "notes.txt"), "utf8")).toBe("feature-content\n");
    await expect(readFile(join(repo, "scratch.txt"), "utf8")).rejects.toThrow();
    expect(await git(repo, ["stash", "list"])).toContain("gateway: 从 main 切换");
  });

  it("切换失败时把 stash 放回原分支", async () => {
    const root = await start();
    const repo = join(root, "app");
    await initRepo(repo);
    await commit(repo, "notes.txt", "base\n", "init");
    await git(repo, ["switch", "-c", "feature"]);
    await git(repo, ["switch", "main"]);
    await git(repo, ["worktree", "add", join(dir, "wt"), "feature"]);
    await writeFile(join(repo, "notes.txt"), "dirty-local\n");
    const ws = await workspace(root);
    const app = (await listed(ws.id)).find((item) => item.name === "app");

    const failed = await authed("POST", `/api/workspaces/${ws.id}/git/switch`, {
      path: app?.path,
      branch: "feature",
      stash: true,
    });
    expect(failed.statusCode).toBe(409);
    expect(failed.json().error).toBe("switch_failed");
    expect((await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("main");
    expect(await readFile(join(repo, "notes.txt"), "utf8")).toBe("dirty-local\n");
    expect((await git(repo, ["stash", "list"])).trim()).toBe("");
  });

  it("有任务在进行时拒绝切换", async () => {
    const root = await start();
    const repo = join(root, "app");
    await initRepo(repo);
    await commit(repo, "notes.txt", "base\n", "init");
    await git(repo, ["switch", "-c", "feature"]);
    await git(repo, ["switch", "main"]);
    const ws = await workspace(root);
    const app = (await listed(ws.id)).find((item) => item.name === "app");
    const db = new DatabaseSync(join(dir, "gateway.db"));
    db.prepare("INSERT INTO runs (id, workspace_id, status, created_at) VALUES (?, ?, 'running', ?)").run(
      "run-1",
      ws.id,
      Date.now(),
    );
    db.close();

    const denied = await authed("POST", `/api/workspaces/${ws.id}/git/switch`, {
      path: app?.path,
      branch: "feature",
    });
    expect(denied.statusCode).toBe(409);
    expect(denied.json()).toMatchObject({ error: "busy" });
    expect((await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("main");
  });

  it("拒绝切换不属于这个 workspace 的路径", async () => {
    const root = await start();
    const repo = join(root, "app");
    await initRepo(repo);
    await commit(repo, "notes.txt", "base\n", "init");
    const outside = join(dir, "outside");
    await initRepo(outside);
    await commit(outside, "notes.txt", "base\n", "init");
    await git(outside, ["switch", "-c", "feature"]);
    const ws = await workspace(root);

    const denied = await authed("POST", `/api/workspaces/${ws.id}/git/switch`, {
      path: outside,
      branch: "feature",
    });
    expect(denied.statusCode).toBe(400);
    expect(denied.json().message).toBe("仓库不属于这个 workspace");
    expect((await git(outside, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("feature");
  });

  it("只返回本地改动的文件列表", async () => {
    const root = await start();
    const repo = join(root, "app");
    await initRepo(repo);
    await commit(repo, "notes.txt", "base\n", "init");
    await writeFile(join(repo, "notes.txt"), "dirty-local\n");
    await writeFile(join(repo, "scratch.txt"), "untracked\n");
    const ws = await workspace(root);
    const app = (await listed(ws.id)).find((item) => item.name === "app");

    const status = await authed("POST", `/api/workspaces/${ws.id}/git/status`, { path: app?.path });
    expect(status.statusCode).toBe(200);
    expect(status.json().files).toEqual(expect.arrayContaining([
      { path: "notes.txt", code: "M", added: 1, deleted: 1 },
      { path: "scratch.txt", code: "??", added: 1, deleted: 0 },
    ]));
  });

  it("只刷新指定仓库的 origin，并可以切到新的远程分支", async () => {
    const root = await start();
    const origin = join(dir, "origin.git");
    const repo = join(root, "app");
    const solo = join(root, "solo");
    await git(dir, ["init", "--bare", "-b", "main", origin]);
    await initRepo(repo);
    await commit(repo, "notes.txt", "base\n", "init");
    await git(repo, ["remote", "add", "origin", origin]);
    await git(repo, ["push", "-u", "origin", "main"]);
    await initRepo(solo);
    await commit(solo, "notes.txt", "base\n", "init");
    const ws = await workspace(root);
    const before = await listed(ws.id);
    const app = before.find((item) => item.name === "app");
    const alone = before.find((item) => item.name === "solo");
    expect(app?.branches.some((item) => item.name === "origin/extra")).toBe(false);

    const cloned = join(dir, "cloned");
    await git(dir, ["clone", origin, cloned]);
    await git(cloned, ["config", "user.email", "test@example.com"]);
    await git(cloned, ["config", "user.name", "Test"]);
    await git(cloned, ["config", "commit.gpgsign", "false"]);
    await git(cloned, ["checkout", "-b", "extra"]);
    await commit(cloned, "notes.txt", "extra\n", "extra");
    await git(cloned, ["push", "-u", "origin", "extra"]);

    const missing = await authed("POST", `/api/workspaces/${ws.id}/git/fetch`, { path: alone?.path });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: "no_origin" });

    const fetched = await authed("POST", `/api/workspaces/${ws.id}/git/fetch`, { path: app?.path });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().branches).toEqual(expect.arrayContaining([{ name: "origin/extra", remote: true }]));
    expect(fetched.json().name).toBe("app");

    const switched = await authed("POST", `/api/workspaces/${ws.id}/git/switch`, {
      path: app?.path,
      branch: "origin/extra",
    });
    expect(switched.statusCode).toBe(200);
    expect(switched.json()).toMatchObject({ branch: "extra", detached: false, name: "app" });
    expect((await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("extra");
    expect((await git(solo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("main");
  });
});

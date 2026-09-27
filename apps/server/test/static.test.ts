import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

describe("网页静态文件", () => {
  let app: FastifyInstance;
  let dir: string;

  afterEach(async () => {
    await app?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function start() {
    dir = await mkdtemp(join(tmpdir(), "gw-web-"));
    const webDir = join(dir, "public");
    await mkdir(join(webDir, "assets"), { recursive: true });
    await writeFile(join(webDir, "index.html"), "<html>gateway</html>");
    await writeFile(join(webDir, "assets", "app.js"), "console.log(1)");
    app = await buildApp({ dbPath: join(dir, "gateway.db"), adminPassword: "pw", webDir });
  }

  it("GET / 返回 index.html", async () => {
    await start();
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("gateway");
  });

  it("静态资源按文件返回", async () => {
    await start();
    const res = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("console.log");
  });

  it("未知前端路径回退到 index.html", async () => {
    await start();
    const res = await app.inject({ method: "GET", url: "/workflow/123" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("gateway");
  });

  it("未登录访问 /api/me 仍返回 401，未知 API 返回 404", async () => {
    await start();
    expect((await app.inject({ method: "GET", url: "/api/me" })).statusCode).toBe(401);
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { password: "pw" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";
    const missing = await app.inject({ method: "GET", url: "/api/nope", headers: { cookie } });
    expect(missing.statusCode).toBe(404);
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

const password = "correct-horse";

function sessionCookie(setCookie: string | string[] | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!raw) throw new Error("missing set-cookie");
  return raw.split(";")[0] ?? "";
}

describe("单用户登录", () => {
  let app: FastifyInstance;
  let dir: string;

  afterEach(async () => {
    await app?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function start() {
    dir = await mkdtemp(join(tmpdir(), "gw-auth-"));
    app = await buildApp({
      dbPath: join(dir, "gateway.db"),
      adminPassword: password,
      cookieSecure: true,
    });
  }

  it("错误密码返回 401", async () => {
    await start();
    const res = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: "wrong" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("正确密码签发的 Cookie 可以访问受保护接口", async () => {
    await start();
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password },
    });
    expect(login.statusCode).toBe(200);
    const setCookie = String(login.headers["set-cookie"]);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Max-Age=2592000/);

    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: sessionCookie(login.headers["set-cookie"]) },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ username: "admin" });
  });

  it("不带 Cookie 访问受保护接口返回 401", async () => {
    await start();
    const res = await app.inject({ method: "GET", url: "/api/me" });
    expect(res.statusCode).toBe(401);
  });

  it("连续失败触发限流", async () => {
    await start();
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/login",
        payload: { password: "wrong" },
      });
      expect(res.statusCode).toBe(401);
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password },
    });
    expect(blocked.statusCode).toBe(429);
  });

  it("退出后原 Cookie 失效", async () => {
    await start();
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password },
    });
    const cookie = sessionCookie(login.headers["set-cookie"]);
    const logout = await app.inject({
      method: "POST",
      url: "/api/logout",
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(200);
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

describe("GET /healthz", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it("返回 200", async () => {
    app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import type { DatabaseSync } from "node:sqlite";

const COOKIE = "gateway_session";
const MAX_AGE_SEC = 60 * 60 * 24 * 30;
const FAIL_LIMIT = 5;
const BLOCK_MS = 15 * 60 * 1000;

type Bucket = { fails: number; blockedUntil: number };

export async function registerAuth(
  app: FastifyInstance,
  db: DatabaseSync,
  options: { adminPassword: string; cookieSecure: boolean },
): Promise<void> {
  const existing = db.prepare("SELECT password_hash FROM admin WHERE id = 1").get() as
    | { password_hash: string }
    | undefined;
  if (!existing) {
    const passwordHash = await argon2.hash(options.adminPassword);
    db.prepare("INSERT INTO admin (id, password_hash) VALUES (1, ?)").run(passwordHash);
  }

  await app.register(cookie);
  const buckets = new Map<string, Bucket>();

  app.addHook("onRequest", async (request, reply) => {
    const url = request.url.split("?")[0] ?? "";
    if (!url.startsWith("/api/") || url === "/api/login") return;
    const sessionId = request.cookies[COOKIE];
    if (!sessionId || !validSession(db, sessionId)) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.post("/api/login", async (request, reply) => {
    const ip = request.ip;
    const bucket = buckets.get(ip);
    if (bucket && bucket.blockedUntil > Date.now()) {
      return reply.code(429).send({ error: "too many attempts" });
    }
    const body = request.body as { password?: string } | undefined;
    const password = body?.password ?? "";
    const row = db.prepare("SELECT password_hash FROM admin WHERE id = 1").get() as {
      password_hash: string;
    };
    const ok = await argon2.verify(row.password_hash, password).catch(() => false);
    if (!ok) {
      let next = bucket ?? { fails: 0, blockedUntil: 0 };
      if (next.blockedUntil > 0 && next.blockedUntil <= Date.now()) {
        next = { fails: 0, blockedUntil: 0 };
      }
      next.fails += 1;
      if (next.fails >= FAIL_LIMIT) next.blockedUntil = Date.now() + BLOCK_MS;
      buckets.set(ip, next);
      return reply.code(401).send({ error: "invalid credentials" });
    }
    buckets.delete(ip);
    const id = randomUUID();
    const expiresAt = Date.now() + MAX_AGE_SEC * 1000;
    db.prepare("INSERT INTO sessions (id, expires_at) VALUES (?, ?)").run(id, expiresAt);
    setSessionCookie(reply, id, options.cookieSecure);
    return { username: "admin" };
  });

  app.post("/api/logout", async (request, reply) => {
    const sessionId = request.cookies[COOKIE];
    if (sessionId) db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/me", async () => ({ username: "admin" }));
}

function validSession(db: DatabaseSync, id: string): boolean {
  const row = db.prepare("SELECT expires_at FROM sessions WHERE id = ?").get(id) as
    | { expires_at: number }
    | undefined;
  if (!row) return false;
  if (row.expires_at <= Date.now()) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return false;
  }
  return true;
}

function setSessionCookie(reply: FastifyReply, id: string, secure: boolean): void {
  reply.setCookie(COOKIE, id, {
    httpOnly: true,
    secure,
    sameSite: "strict",
    path: "/",
    maxAge: MAX_AGE_SEC,
  });
}

export function readSession(request: FastifyRequest): string | undefined {
  return request.cookies[COOKIE];
}

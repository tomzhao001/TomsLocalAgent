import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { normalizeWorkspacePath, pathsOverlap, scanGitRepos } from "./paths.js";

type WorkspaceRow = {
  id: string;
  name: string;
  path: string;
  repos_json: string;
  archived: number;
  created_at: number;
  updated_at: number;
};

export function registerWorkspaces(app: FastifyInstance, db: DatabaseSync, roots: string[]): void {
  app.get("/api/workspaces", async () => {
    return db
      .prepare("SELECT * FROM workspaces ORDER BY created_at")
      .all()
      .map((row) => toDto(row as WorkspaceRow));
  });

  app.post("/api/workspaces", async (request, reply) => {
    const body = request.body as { name?: string; path?: string };
    if (!body?.name?.trim() || !body.path?.trim()) {
      return reply.code(400).send({ error: "invalid", message: "名称和路径都必填" });
    }
    const normalized = normalizeWorkspacePath(body.path, roots);
    if (!normalized.ok) return reply.code(400).send({ error: "invalid", message: normalized.message });
    const overlap = existingPaths(db).find((path) => pathsOverlap(path, normalized.path));
    if (overlap) return reply.code(409).send({ error: "overlap", message: "路径与已有 workspace 重叠" });
    const now = Date.now();
    const id = randomUUID();
    const repos = scanGitRepos(normalized.path);
    db.prepare(
      `INSERT INTO workspaces (id, name, path, repos_json, archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
    ).run(id, body.name.trim(), normalized.path, JSON.stringify(repos), now, now);
    return reply.code(201).send(load(db, id));
  });

  app.patch("/api/workspaces/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const current = row(db, id);
    if (!current) return reply.code(404).send({ error: "not_found", message: "workspace 不存在" });
    const body = request.body as { name?: string; path?: string };
    let name = current.name;
    let path = current.path;
    let repos = current.repos_json;
    if (body.name?.trim()) name = body.name.trim();
    if (body.path?.trim()) {
      if (referenceCount(db, id) > 0) {
        return reply.code(409).send({ error: "referenced", message: "已被引用，不能修改路径" });
      }
      const normalized = normalizeWorkspacePath(body.path, roots);
      if (!normalized.ok) return reply.code(400).send({ error: "invalid", message: normalized.message });
      const overlap = existingPaths(db, id).find((item) => pathsOverlap(item, normalized.path));
      if (overlap) return reply.code(409).send({ error: "overlap", message: "路径与已有 workspace 重叠" });
      path = normalized.path;
      repos = JSON.stringify(scanGitRepos(path));
    }
    db.prepare("UPDATE workspaces SET name = ?, path = ?, repos_json = ?, updated_at = ? WHERE id = ?").run(
      name,
      path,
      repos,
      Date.now(),
      id,
    );
    return load(db, id);
  });

  app.delete("/api/workspaces/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!row(db, id)) return reply.code(404).send({ error: "not_found", message: "workspace 不存在" });
    if (referenceCount(db, id) > 0) {
      return reply.code(409).send({ error: "referenced", message: "已被引用，只能归档" });
    }
    db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
    return reply.code(204).send();
  });

  app.post("/api/workspaces/:id/archive", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!row(db, id)) return reply.code(404).send({ error: "not_found", message: "workspace 不存在" });
    if (runningCount(db, id) > 0) {
      return reply.code(409).send({ error: "busy", message: "有运行中的任务，不能归档" });
    }
    db.prepare("UPDATE workspaces SET archived = 1, updated_at = ? WHERE id = ?").run(Date.now(), id);
    return load(db, id);
  });

  app.post("/api/workspaces/:id/scan", async (request, reply) => {
    const { id } = request.params as { id: string };
    const current = row(db, id);
    if (!current) return reply.code(404).send({ error: "not_found", message: "workspace 不存在" });
    const repos = JSON.stringify(scanGitRepos(current.path));
    db.prepare("UPDATE workspaces SET repos_json = ?, updated_at = ? WHERE id = ?").run(repos, Date.now(), id);
    return load(db, id);
  });

  app.post("/api/sessions", async (request, reply) => {
    const body = request.body as { provider?: string; workspaceId?: string; title?: string };
    if (body.provider !== "cursor" && body.provider !== "opencode") {
      return reply.code(400).send({ error: "invalid", message: "provider 必须是 cursor 或 opencode" });
    }
    const workspace = body.workspaceId ? row(db, body.workspaceId) : undefined;
    if (!workspace) return reply.code(404).send({ error: "not_found", message: "workspace 不存在" });
    if (workspace.archived) return reply.code(409).send({ error: "archived", message: "已归档的 workspace 不能新建聊天" });
    const id = randomUUID();
    db.prepare(
      "INSERT INTO chat_sessions (id, provider, workspace_id, title, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, body.provider, workspace.id, body.title ?? null, Date.now());
    return reply.code(201).send({
      id,
      provider: body.provider,
      workspaceId: workspace.id,
      title: body.title ?? null,
    });
  });
}

function existingPaths(db: DatabaseSync, exceptId?: string): string[] {
  const rows = db.prepare("SELECT id, path FROM workspaces").all() as { id: string; path: string }[];
  return rows.filter((item) => item.id !== exceptId).map((item) => item.path);
}

function referenceCount(db: DatabaseSync, id: string): number {
  const chats = db.prepare("SELECT COUNT(*) AS n FROM chat_sessions WHERE workspace_id = ?").get(id) as { n: number };
  return Number(chats.n);
}

function runningCount(db: DatabaseSync, id: string): number {
  const runs = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE workspace_id = ? AND status = 'running'").get(id) as {
    n: number;
  };
  return Number(runs.n);
}

function row(db: DatabaseSync, id: string): WorkspaceRow | undefined {
  return db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as WorkspaceRow | undefined;
}

function load(db: DatabaseSync, id: string) {
  return toDto(row(db, id)!);
}

function toDto(row: WorkspaceRow) {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    repos: JSON.parse(row.repos_json) as string[],
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

import { DatabaseSync } from "node:sqlite";

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  if (hasTable(db, "workspace_locks") && !hasColumn(db, "workspace_locks", "kind")) {
    db.exec("DROP TABLE workspace_locks");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      path TEXT UNIQUE NOT NULL,
      repos_json TEXT NOT NULL DEFAULT '[]',
      archived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      title TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      session_id TEXT,
      model TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_locks (
      workspace_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'chat',
      holder_type TEXT NOT NULL,
      holder_id TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, kind)
    );
    CREATE TABLE IF NOT EXISTS split_tasks (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      chat_session_id TEXT,
      prompt TEXT NOT NULL,
      model TEXT,
      agent_id TEXT,
      status TEXT NOT NULL,
      draft_json TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS split_tasks_one_running
      ON split_tasks(workspace_id) WHERE status = 'running';
    CREATE TABLE IF NOT EXISTS features (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      split_task_id TEXT,
      title TEXT NOT NULL,
      shared_context TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS requirements (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      feature_id TEXT REFERENCES features(id),
      seq INTEGER NOT NULL,
      card_json TEXT NOT NULL,
      status TEXT NOT NULL,
      agent_id TEXT,
      state_json TEXT,
      pending_action_json TEXT,
      wait_json TEXT,
      version INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS requirements_one_active
      ON requirements(workspace_id) WHERE status IN ('running', 'waiting_input');
    CREATE INDEX IF NOT EXISTS requirements_queue ON requirements(workspace_id, status, seq);
    CREATE INDEX IF NOT EXISTS requirements_history ON requirements(workspace_id, status, finished_at);
    CREATE TABLE IF NOT EXISTS step_runs (
      id TEXT PRIMARY KEY,
      requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
      step TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      status TEXT NOT NULL,
      result_json TEXT,
      consumed INTEGER NOT NULL DEFAULT 0,
      user_input TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS step_runs_requirement ON step_runs(requirement_id, started_at);
    CREATE TRIGGER IF NOT EXISTS chat_sessions_workspace_immutable
    BEFORE UPDATE OF workspace_id ON chat_sessions
    BEGIN
      SELECT RAISE(ABORT, 'workspace_id is immutable');
    END;
  `);
  ensureColumn(db, "runs", "session_id", "TEXT");
  ensureColumn(db, "runs", "model", "TEXT");
  ensureColumn(db, "runs", "prompt", "TEXT");
  ensureColumn(db, "runs", "plan_json", "TEXT");
  ensureColumn(db, "chat_sessions", "agent_id", "TEXT");
  ensureColumn(db, "step_runs", "trace_json", "TEXT");
  ensureColumn(db, "requirements", "workflow_id", "TEXT NOT NULL DEFAULT 'cursor-dev-loop'");
  ensureColumn(db, "workspaces", "chat_model", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "workspaces", "develop_model", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "workspaces", "review_model", "TEXT NOT NULL DEFAULT ''");
  return db;
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function dbOpen(db: DatabaseSync): boolean {
  try {
    db.prepare("SELECT 1").get();
    return true;
  } catch {
    return false;
  }
}

function hasTable(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((item) => item.name === column);
}

function ensureColumn(db: DatabaseSync, table: string, column: string, type: string): void {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

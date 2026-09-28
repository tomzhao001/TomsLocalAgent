import type { DatabaseSync } from "node:sqlite";

export type LockKind = "chat" | "workflow";

export type LockHolder = { type: string; id: string };

export class WorkspaceLockManager {
  constructor(private readonly db: DatabaseSync) {}

  tryAcquire(workspaceId: string, kind: LockKind, holder: LockHolder): { ok: true } | { ok: false; holder: LockHolder } {
    const existing = this.holder(workspaceId, kind);
    if (existing) {
      if (existing.id === holder.id) return { ok: true };
      return { ok: false, holder: existing };
    }
    this.db
      .prepare(
        "INSERT INTO workspace_locks (workspace_id, kind, holder_type, holder_id, acquired_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(workspaceId, kind, holder.type, holder.id, Date.now());
    return { ok: true };
  }

  holder(workspaceId: string, kind: LockKind): LockHolder | null {
    const row = this.db
      .prepare("SELECT holder_type, holder_id FROM workspace_locks WHERE workspace_id = ? AND kind = ?")
      .get(workspaceId, kind) as { holder_type: string; holder_id: string } | undefined;
    return row ? { type: row.holder_type, id: row.holder_id } : null;
  }

  release(workspaceId: string, kind: LockKind, holderId: string): void {
    this.db
      .prepare("DELETE FROM workspace_locks WHERE workspace_id = ? AND kind = ? AND holder_id = ?")
      .run(workspaceId, kind, holderId);
  }

  clearStale(): void {
    this.db.exec(`
      DELETE FROM workspace_locks
      WHERE kind = 'chat'
        AND holder_id NOT IN (SELECT id FROM runs WHERE status = 'running');
      DELETE FROM workspace_locks
      WHERE kind = 'workflow'
        AND workspace_id NOT IN (
          SELECT workspace_id FROM requirements WHERE status IN ('pending', 'running', 'waiting_input')
        );
    `);
  }
}

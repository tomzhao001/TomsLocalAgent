import type { DatabaseSync } from "node:sqlite";

export type LockHolder = { type: string; id: string };

export class WorkspaceLockManager {
  constructor(private readonly db: DatabaseSync) {}

  tryAcquire(workspaceId: string, holder: LockHolder): { ok: true } | { ok: false; holder: LockHolder } {
    const existing = this.db
      .prepare("SELECT holder_type, holder_id FROM workspace_locks WHERE workspace_id = ?")
      .get(workspaceId) as { holder_type: string; holder_id: string } | undefined;
    if (existing) return { ok: false, holder: { type: existing.holder_type, id: existing.holder_id } };
    this.db
      .prepare(
        "INSERT INTO workspace_locks (workspace_id, holder_type, holder_id, acquired_at) VALUES (?, ?, ?, ?)",
      )
      .run(workspaceId, holder.type, holder.id, Date.now());
    return { ok: true };
  }

  release(workspaceId: string, holderId: string): void {
    this.db.prepare("DELETE FROM workspace_locks WHERE workspace_id = ? AND holder_id = ?").run(workspaceId, holderId);
  }

  clearStale(): void {
    this.db.exec(`
      DELETE FROM workspace_locks
      WHERE holder_type = 'run'
        AND holder_id NOT IN (SELECT id FROM runs WHERE status = 'running')
    `);
  }
}

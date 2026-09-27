import { copyFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export function backupDatabase(dbPath: string, destDir: string): string {
  const dest = join(destDir, `gateway-${Date.now()}.db`);
  copyFileSync(dbPath, dest);
  return dest;
}

export function cleanupLogs(root: string, olderThanMs: number, now = Date.now()): number {
  let removed = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (now - statSync(path).mtimeMs > olderThanMs) {
        rmSync(path);
        removed += 1;
      }
    }
  };
  try {
    walk(root);
  } catch {
    return removed;
  }
  return removed;
}

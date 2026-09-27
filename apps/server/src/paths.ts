import { realpathSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

export function normalizeWorkspacePath(
  input: string,
  roots: string[],
): { ok: true; path: string } | { ok: false; message: string } {
  let resolved: string;
  try {
    resolved = realpathSync(input);
    if (!statSync(resolved).isDirectory()) {
      return { ok: false, message: "路径必须是已存在的目录" };
    }
  } catch {
    return { ok: false, message: "路径必须是已存在的目录" };
  }

  const allowed = roots.flatMap((root) => {
    try {
      return [realpathSync(root)];
    } catch {
      return [];
    }
  });
  const inside = allowed.some((root) => sameOrChild(resolved, root));
  if (!inside) return { ok: false, message: "路径必须位于允许的根目录之下" };
  return { ok: true, path: resolved };
}

export function pathsOverlap(left: string, right: string): boolean {
  return sameOrChild(left, right) || sameOrChild(right, left);
}

export function scanGitRepos(root: string, maxDepth = 3): string[] {
  const found: string[] = [];
  walk(root, 0, maxDepth, found);
  return found.sort();
}

function walk(dir: string, depth: number, maxDepth: number, found: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((entry) => entry.name === ".git")) found.push(dir);
  if (depth >= maxDepth) return;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".git") continue;
    walk(join(dir, entry.name), depth + 1, maxDepth, found);
  }
}

function sameOrChild(child: string, parent: string): boolean {
  const c = fold(child);
  const p = fold(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

function fold(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

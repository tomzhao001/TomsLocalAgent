import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { relative, sep } from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { runningCount } from "./workspaces.js";

const execFileAsync = promisify(execFile);

export type GitBranchRef = { name: string; remote: boolean };

export type GitRepoState = {
  path: string;
  name: string;
  branch: string;
  detached: boolean;
  dirty: boolean;
  branches: GitBranchRef[];
  error?: string;
};

export type GitChange = { path: string; code: string; added: number | null; deleted: number | null };

export class GitOpError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
  }
}

type SwitchTarget = { localName: string; track: boolean };

export function registerGitBranches(app: FastifyInstance, db: DatabaseSync): void {
  app.get("/api/workspaces/:id/git", async (request, reply) => {
    const workspace = loadWorkspace(db, (request.params as { id: string }).id);
    if (!workspace) return reply.code(404).send({ error: "not_found", message: "workspace 不存在" });
    const repos = await Promise.all(workspace.repos.map((repo) => readRepo(workspace.path, repo)));
    return { repos };
  });

  app.post("/api/workspaces/:id/git/fetch", async (request, reply) => {
    const found = findRepo(db, request, reply);
    if (!found) return;
    try {
      return await fetchOrigin(found.workspacePath, found.repo);
    } catch (error) {
      return sendGitError(reply, error);
    }
  });

  app.post("/api/workspaces/:id/git/status", async (request, reply) => {
    const found = findRepo(db, request, reply);
    if (!found) return;
    try {
      return { files: await statusFiles(found.repo) };
    } catch (error) {
      return sendGitError(reply, error);
    }
  });

  app.post("/api/workspaces/:id/git/switch", async (request, reply) => {
    const found = findRepo(db, request, reply);
    if (!found) return;
    const branch = (request.body as { branch?: string } | undefined)?.branch?.trim() ?? "";
    const stash = (request.body as { stash?: boolean } | undefined)?.stash === true;
    if (!branch) return reply.code(400).send({ error: "invalid", message: "要切换的分支不能为空" });
    if (runningCount(db, found.id) > 0) {
      return reply.code(409).send({ error: "busy", message: "有聊天、工作流或拆卡在进行，不能切换分支" });
    }
    try {
      return await switchBranch(found.workspacePath, found.repo, branch, stash);
    } catch (error) {
      return sendGitError(reply, error);
    }
  });
}

export async function readRepo(workspacePath: string, repoPath: string): Promise<GitRepoState> {
  let canonical = repoPath;
  try {
    canonical = realpathSync(repoPath);
  } catch (error) {
    return {
      path: repoPath,
      name: repoName(workspacePath, repoPath),
      branch: "",
      detached: false,
      dirty: false,
      branches: [],
      error: gitMessage(error),
    };
  }
  const name = repoName(workspacePath, canonical);
  try {
    const [head, refs, files] = await Promise.all([
      git(canonical, ["rev-parse", "--abbrev-ref", "HEAD"]),
      git(canonical, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin"]),
      git(canonical, ["status", "--porcelain=v1", "-z", "-uall"]),
    ]);
    const branch = head.trim();
    return {
      path: canonical,
      name,
      branch,
      detached: branch === "HEAD",
      dirty: files.length > 0,
      branches: parseRefs(refs),
    };
  } catch (error) {
    return {
      path: canonical,
      name,
      branch: "",
      detached: false,
      dirty: false,
      branches: [],
      error: gitMessage(error),
    };
  }
}

export async function fetchOrigin(workspacePath: string, repo: string): Promise<GitRepoState> {
  try {
    await git(repo, ["remote", "get-url", "origin"]);
  } catch {
    throw new GitOpError("这个仓库没有 origin", 400, "no_origin");
  }
  try {
    await git(repo, ["fetch", "--prune", "origin"], 60_000);
  } catch (error) {
    throw new GitOpError(gitMessage(error), 409, "fetch_failed");
  }
  const state = await readRepo(workspacePath, repo);
  if (state.error) throw new GitOpError(state.error, 409, "fetch_failed");
  return state;
}

export async function switchBranch(
  workspacePath: string,
  repo: string,
  branch: string,
  stash: boolean,
): Promise<GitRepoState> {
  const state = await readRepo(workspacePath, repo);
  if (state.error) throw new GitOpError(state.error, 400, "invalid");
  const target = resolveSwitch(branch, state.branches);
  if (!target) throw new GitOpError("分支不存在", 400, "invalid");
  try {
    await git(repo, ["check-ref-format", "--branch", target.track ? branch : target.localName]);
  } catch {
    throw new GitOpError("分支名不合法", 400, "invalid");
  }
  if (!state.detached && state.branch === target.localName) return state;
  if (state.dirty && !stash) throw new GitOpError("工作区有未提交改动", 409, "dirty");

  let stashed = false;
  if (state.dirty && stash) {
    const from = state.detached ? "游离 HEAD" : state.branch;
    try {
      await git(repo, ["stash", "push", "--include-untracked", "-m", `gateway: 从 ${from} 切换`]);
      stashed = true;
    } catch (error) {
      throw new GitOpError(gitMessage(error), 409, "stash_failed");
    }
  }

  try {
    if (target.track) await git(repo, ["switch", "--track", branch]);
    else await git(repo, ["switch", target.localName]);
  } catch (error) {
    if (stashed) {
      try {
        await git(repo, ["stash", "pop"]);
      } catch (popError) {
        throw new GitOpError(
          `${gitMessage(error)}；尝试恢复 stash 也失败了：${gitMessage(popError)}`,
          409,
          "switch_failed",
        );
      }
    }
    throw new GitOpError(gitMessage(error), 409, "switch_failed");
  }

  const next = await readRepo(workspacePath, repo);
  if (next.error) throw new GitOpError(next.error, 409, "switch_failed");
  return next;
}

async function statusFiles(repo: string): Promise<GitChange[]> {
  const porcelain = await git(repo, ["status", "--porcelain=v1", "-z", "-uall"]);
  const files = parseStatus(porcelain);
  let stats = new Map<string, LineStat>();
  try {
    stats = parseNumstat(await git(repo, ["diff", "--numstat", "-z", "HEAD"], undefined, true));
  } catch {
    stats = new Map();
  }
  await Promise.all(
    files
      .filter((file) => !stats.has(file.path))
      .map(async (file) => {
        stats.set(file.path, await untrackedStat(repo, file.path));
      }),
  );
  return files.map((file) => {
    const stat = stats.get(file.path) ?? { added: null, deleted: null };
    return { ...file, added: stat.added, deleted: stat.deleted };
  });
}

async function untrackedStat(repo: string, file: string): Promise<LineStat> {
  try {
    const parsed = parseNumstat(
      await git(repo, ["diff", "--numstat", "--no-index", "-z", "--", "/dev/null", file], undefined, true),
    );
    return [...parsed.values()][0] ?? { added: 0, deleted: 0 };
  } catch {
    return { added: null, deleted: null };
  }
}

function parseStatus(stdout: string): { path: string; code: string }[] {
  const files: { path: string; code: string }[] = [];
  let index = 0;
  while (index + 4 <= stdout.length) {
    const xy = stdout.slice(index, index + 2);
    const start = index + 3;
    const end = stdout.indexOf("\0", start);
    if (end < 0) break;
    let file = stdout.slice(start, end);
    index = end + 1;
    if (xy.includes("R") || xy.includes("C")) {
      const renamed = stdout.indexOf("\0", index);
      if (renamed < 0) break;
      file = stdout.slice(index, renamed);
      index = renamed + 1;
    }
    files.push({ path: file, code: xy === "??" ? "??" : xy.replaceAll(" ", "") || xy });
  }
  return files;
}

type LineStat = { added: number | null; deleted: number | null };

function parseNumstat(stdout: string): Map<string, LineStat> {
  const stats = new Map<string, LineStat>();
  let index = 0;
  while (index < stdout.length) {
    const end = stdout.indexOf("\0", index);
    const record = stdout.slice(index, end < 0 ? stdout.length : end);
    index = end < 0 ? stdout.length : end + 1;
    if (!record) continue;
    const parts = record.split("\t");
    if (parts.length < 2) continue;
    const stat = lineStat(parts[0] ?? "", parts[1] ?? "");
    if (parts[2]) {
      stats.set(parts.slice(2).join("\t"), stat);
      continue;
    }
    const oldEnd = stdout.indexOf("\0", index);
    if (oldEnd < 0) break;
    index = oldEnd + 1;
    const newEnd = stdout.indexOf("\0", index);
    if (newEnd < 0) break;
    stats.set(stdout.slice(index, newEnd), stat);
    index = newEnd + 1;
  }
  return stats;
}

function lineStat(added: string, deleted: string): LineStat {
  if (added === "-" || deleted === "-") return { added: null, deleted: null };
  const addedLines = Number(added);
  const deletedLines = Number(deleted);
  if (!Number.isInteger(addedLines) || !Number.isInteger(deletedLines)) return { added: null, deleted: null };
  return { added: addedLines, deleted: deletedLines };
}

function parseRefs(stdout: string): GitBranchRef[] {
  const branches: GitBranchRef[] = [];
  const seen = new Set<string>();
  for (const ref of stdout.split(/\r?\n/)) {
    if (ref.startsWith("refs/heads/")) {
      const name = ref.slice("refs/heads/".length);
      if (!name || seen.has(`local:${name}`)) continue;
      seen.add(`local:${name}`);
      branches.push({ name, remote: false });
    } else if (ref.startsWith("refs/remotes/origin/")) {
      const rest = ref.slice("refs/remotes/origin/".length);
      if (!rest || rest === "HEAD") continue;
      const name = `origin/${rest}`;
      if (seen.has(`remote:${name}`)) continue;
      seen.add(`remote:${name}`);
      branches.push({ name, remote: true });
    }
  }
  branches.sort((a, b) => Number(a.remote) - Number(b.remote) || a.name.localeCompare(b.name));
  return branches;
}

function resolveSwitch(branch: string, branches: GitBranchRef[]): SwitchTarget | null {
  if (!branch || branch.startsWith("-") || branch.includes("..")) return null;
  if (branch.startsWith("origin/")) {
    if (branch === "origin/HEAD" || !branches.some((item) => item.remote && item.name === branch)) return null;
    const localName = branch.slice("origin/".length);
    if (!localName) return null;
    if (branches.some((item) => !item.remote && item.name === localName)) return { localName, track: false };
    return { localName, track: true };
  }
  if (!branches.some((item) => !item.remote && item.name === branch)) return null;
  return { localName: branch, track: false };
}

function findRepo(
  db: DatabaseSync,
  request: FastifyRequest,
  reply: FastifyReply,
): { id: string; workspacePath: string; repo: string } | undefined {
  const id = (request.params as { id: string }).id;
  const workspace = loadWorkspace(db, id);
  if (!workspace) {
    reply.code(404).send({ error: "not_found", message: "workspace 不存在" });
    return;
  }
  const requested = (request.body as { path?: string } | undefined)?.path?.trim() ?? "";
  if (!requested) {
    reply.code(400).send({ error: "invalid", message: "仓库路径不能为空" });
    return;
  }
  const repo = resolveWorkspaceRepo(workspace.path, workspace.repos, requested);
  if (!repo) {
    reply.code(400).send({ error: "invalid", message: "仓库不属于这个 workspace" });
    return;
  }
  return { id, workspacePath: workspace.path, repo };
}

function loadWorkspace(db: DatabaseSync, id: string): { path: string; repos: string[] } | undefined {
  const row = db.prepare("SELECT path, repos_json FROM workspaces WHERE id = ?").get(id) as
    | { path: string; repos_json: string }
    | undefined;
  if (!row) return;
  try {
    const repos = JSON.parse(row.repos_json) as unknown;
    return { path: row.path, repos: Array.isArray(repos) ? repos.filter((item) => typeof item === "string") : [] };
  } catch {
    return { path: row.path, repos: [] };
  }
}

export function resolveWorkspaceRepo(workspacePath: string, repos: string[], requested: string): string | null {
  let repoPath: string;
  let workspaceReal: string;
  try {
    repoPath = realpathSync(requested);
    workspaceReal = realpathSync(workspacePath);
  } catch {
    return null;
  }
  if (!contains(workspaceReal, repoPath)) return null;
  const owned = repos.some((repo) => {
    try {
      return samePath(realpathSync(repo), repoPath);
    } catch {
      return false;
    }
  });
  return owned ? repoPath : null;
}

function sendGitError(reply: FastifyReply, error: unknown) {
  if (error instanceof GitOpError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  return reply.code(500).send({ error: "git_failed", message: gitMessage(error) });
}

function git(cwd: string, args: string[], timeout?: number, allowExitCode1 = false): Promise<string> {
  return execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
    timeout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" },
  }).then(
    (result) => result.stdout,
    (error: unknown) => {
      const code = error && typeof error === "object" ? (error as { code?: number; stdout?: string; killed?: boolean }) : undefined;
      if (allowExitCode1 && code?.code === 1 && !code.killed) return String(code.stdout ?? "");
      throw new Error(gitMessage(error));
    },
  );
}

function gitMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const err = error as { killed?: boolean; signal?: string | null; stderr?: string; message?: string };
    if (err.killed || err.signal === "SIGTERM") return "git 命令超时";
    const stderr = String(err.stderr ?? "").trim();
    if (stderr) return stderr;
    if (err.message?.trim()) return err.message.trim();
  }
  return "git 失败";
}

function repoName(workspacePath: string, repoPath: string): string {
  let rel = "";
  try {
    rel = relative(realpathSync(workspacePath), realpathSync(repoPath));
  } catch {
    rel = relative(workspacePath, repoPath);
  }
  if (!rel || rel === ".") return ".";
  return rel.split(sep).join("/");
}

function contains(parent: string, child: string): boolean {
  const root = fold(parent);
  const target = fold(child);
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

function samePath(left: string, right: string): boolean {
  return fold(left) === fold(right);
}

function fold(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

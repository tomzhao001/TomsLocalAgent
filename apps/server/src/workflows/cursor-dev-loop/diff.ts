import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const REVIEW_DIFF_LIMIT = 80_000;
const FILE_LIMIT = 20_000;

const sourceExt = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".vue",
  ".svelte",
  ".css",
  ".scss",
  ".html",
  ".json",
  ".md",
  ".yml",
  ".yaml",
  ".sql",
]);

type RepoPiece = {
  repo: string;
  stat: string;
  body: string;
  paths: string[];
};

export async function collectReviewDiff(repos: string[]): Promise<string> {
  if (repos.length === 0) {
    return "## 本次改动\n\n没有发现 git 仓库，无法提供 diff。若因此无法判断验收标准，请在 comments 里说明并 reject。";
  }
  const pieces: RepoPiece[] = [];
  for (const repo of repos) {
    const piece = await repoDiff(repo);
    if (piece) pieces.push(piece);
  }
  if (pieces.length === 0) {
    return "## 本次改动\n\n各仓库都没有相对 HEAD 的改动。若因此无法判断验收标准，请在 comments 里说明并 reject。";
  }
  const full = ["## 本次改动", ...pieces.map((piece) => piece.body)].join("\n\n");
  if (full.length <= REVIEW_DIFF_LIMIT) return full;
  const lines = [
    "## 本次改动",
    "改动超过长度上限。下面只有 diff stat 和路径。只阅读这些路径，不要搜索整个仓库。",
  ];
  for (const piece of pieces) {
    const listed = [...new Set(piece.paths)];
    lines.push(`### ${piece.repo}`, piece.stat || "（无 stat）", listed.length ? listed.map((item) => `- ${item}`).join("\n") : "（无路径）");
  }
  return lines.join("\n\n");
}

async function repoDiff(repo: string): Promise<RepoPiece | null> {
  try {
    await git(repo, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return null;
  }
  const compared = await comparedDiff(repo);
  const untracked = await listUntracked(repo);
  const fileBodies: string[] = [];
  const paths = [...pathsFromDiff(compared.patch).map(slash), ...untracked.map(slash)];
  for (const file of untracked) {
    const loaded = await readSource(repo, file);
    if (loaded) fileBodies.push(loaded);
  }
  if (!compared.patch.trim() && fileBodies.length === 0 && !compared.stat.trim()) return null;
  const body = [`### ${repo}`, compared.stat && `\`\`\`\n${compared.stat.trim()}\n\`\`\``, compared.patch && `\`\`\`diff\n${compared.patch.trim()}\n\`\`\``, ...fileBodies]
    .filter(Boolean)
    .join("\n\n");
  return { repo, stat: compared.stat.trim(), body, paths };
}

async function comparedDiff(repo: string): Promise<{ patch: string; stat: string }> {
  try {
    const [patch, stat] = await Promise.all([git(repo, ["diff", "HEAD"]), git(repo, ["diff", "--stat", "HEAD"])]);
    return { patch, stat };
  } catch {
    const [patch, stat] = await Promise.all([
      git(repo, ["diff"]).catch(() => ""),
      git(repo, ["diff", "--stat"]).catch(() => ""),
    ]);
    return { patch, stat };
  }
}

async function listUntracked(repo: string): Promise<string[]> {
  const listed = await git(repo, ["ls-files", "--others", "--exclude-standard"]).catch(() => "");
  return listed
    .split("\n")
    .map((line) => line.trim())
    .filter((file) => file && sourceExt.has(extOf(file)));
}

async function readSource(repo: string, file: string): Promise<string | null> {
  try {
    const text = await readFile(join(repo, file), "utf8");
    if (text.includes("\u0000")) return null;
    const clipped = text.length > FILE_LIMIT ? `${text.slice(0, FILE_LIMIT)}\n…（文件已截断）` : text;
    return `### 未跟踪 ${file}\n\n\`\`\`\n${clipped}\n\`\`\``;
  } catch {
    return null;
  }
}

function pathsFromDiff(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split("\n")) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (match?.[2]) paths.push(match[2]);
  }
  return paths;
}

function slash(file: string): string {
  return file.replaceAll("\\", "/");
}

function extOf(file: string): string {
  const dot = file.lastIndexOf(".");
  return dot < 0 ? "" : file.slice(dot).toLowerCase();
}

function git(cwd: string, args: string[]): Promise<string> {
  return execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024, windowsHide: true }).then((result) => result.stdout);
}

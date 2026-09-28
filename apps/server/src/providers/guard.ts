import { execFile } from "node:child_process";

export const readonlyViolation = "只读运行检测到文件改动";

export async function repoSnapshot(repos: string[]): Promise<string> {
  const parts: string[] = [];
  for (const repo of repos) {
    parts.push(`${repo}\n${await gitStatus(repo)}`);
  }
  return parts.join("\n");
}

export async function watchReadonly(repos: string[]): Promise<() => Promise<boolean>> {
  if (repos.length === 0) return async () => false;
  const before = await repoSnapshot(repos);
  return async () => (await repoSnapshot(repos)) !== before;
}

function gitStatus(repo: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", ["-C", repo, "status", "--porcelain"], { windowsHide: true }, (error, stdout) => {
      resolve(error ? `error: ${error.message}` : stdout);
    });
  });
}

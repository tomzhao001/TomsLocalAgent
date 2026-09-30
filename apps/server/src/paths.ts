import { spawn } from "node:child_process";
import { realpathSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

export function normalizeWorkspacePath(input: string): { ok: true; path: string } | { ok: false; message: string } {
  const trimmed = input.trim().replace(/^["']|["']$/g, "");
  let resolved: string;
  try {
    resolved = realpathSync(trimmed);
    if (!statSync(resolved).isDirectory()) {
      return { ok: false, message: "路径必须是已存在的目录" };
    }
  } catch {
    return { ok: false, message: "路径必须是已存在的目录" };
  }
  return { ok: true, path: resolved };
}

export function pickDirectory(): Promise<string | null> {
  if (process.platform === "win32") {
    return run("powershell.exe", ["-NoProfile", "-STA", "-Command", windowsPicker]);
  }
  if (process.platform === "darwin") {
    return run("osascript", ["-e", 'POSIX path of (choose folder with prompt "选择 workspace 目录")']);
  }
  return run("zenity", ["--file-selection", "--directory", "--title=选择 workspace 目录"]);
}

const windowsPicker = `
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "选择 workspace 目录"
$dialog.ShowNewFolderButton = $false
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.WriteLine($dialog.SelectedPath)
}
$owner.Dispose()
`;

function run(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("选择目录超时"));
    }, 5 * 60 * 1000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const path = stdout.trim();
      if (path) {
        resolve(path);
        return;
      }
      const detail = stderr.trim();
      if (code && code !== 0 && detail && !/cancel/i.test(detail)) {
        reject(new Error(detail));
        return;
      }
      resolve(null);
    });
  });
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

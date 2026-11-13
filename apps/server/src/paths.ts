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

export function pickDirectory(initialPath?: string): Promise<string | null> {
  const env = { ...process.env, GATEWAY_BROWSE_INITIAL: initialPath ?? "" };
  if (process.platform === "win32") {
    return run("powershell.exe", ["-NoProfile", "-STA", "-Command", windowsPicker], env);
  }
  if (process.platform === "darwin") {
    return run("osascript", ["-e", macPicker], env);
  }
  const args = ["--file-selection", "--directory", "--title=选择 workspace 目录"];
  if (initialPath) args.push(`--filename=${initialPath.endsWith("/") ? initialPath : `${initialPath}/`}`);
  return run("zenity", args, env);
}

const windowsPicker = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DialogForeground {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr lpdwProcessId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
}
'@
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$owner.Width = 1
$owner.Height = 1
$owner.Show()
$owner.Activate()
$fg = [DialogForeground]::GetForegroundWindow()
$fgThread = [DialogForeground]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
$myThread = [DialogForeground]::GetCurrentThreadId()
$attached = $false
if ($fg -ne [IntPtr]::Zero -and $fgThread -ne 0 -and $fgThread -ne $myThread) {
  $attached = [DialogForeground]::AttachThreadInput($myThread, $fgThread, $true)
}
[void][DialogForeground]::SetForegroundWindow($owner.Handle)
$owner.Activate()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "选择 workspace 目录"
$dialog.ShowNewFolderButton = $false
$dialog.AutoUpgradeEnabled = $true
$initial = $env:GATEWAY_BROWSE_INITIAL
if ($initial -and (Test-Path -LiteralPath $initial -PathType Container)) {
  $dialog.SelectedPath = $initial
}
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.WriteLine($dialog.SelectedPath)
}
if ($attached) {
  [void][DialogForeground]::AttachThreadInput($myThread, $fgThread, $false)
}
$owner.Dispose()
`;

const macPicker = `
set startPath to system attribute "GATEWAY_BROWSE_INITIAL"
if startPath is not "" then
  POSIX path of (choose folder with prompt "选择 workspace 目录" default location POSIX file startPath)
else
  POSIX path of (choose folder with prompt "选择 workspace 目录")
end if
`;

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, env });
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

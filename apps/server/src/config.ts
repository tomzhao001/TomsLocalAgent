import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const DEFAULT_PORT = 3701;
export const DEFAULT_OPENCODE_PORT = 3702;

type Env = Record<string, string | undefined>;

export type GatewayConfig = {
  envFile: string;
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  logDir: string;
  webDir: string;
  adminPassword: string;
  cookieSecure: boolean;
  workspaceRoots: string[];
  cursorApiKey?: string;
  opencode: { enabled: boolean; port: number; password?: string };
  fakeRuntime: boolean;
  dispatchIntervalMs: number;
  workflowModel: string;
};

export function defaultDataDir(platform: NodeJS.Platform = process.platform, env: Env = process.env, home = homedir()): string {
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "TomsGateway");
  if (platform === "darwin") return join(home, "Library", "Application Support", "TomsGateway");
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "toms-gateway");
}

export function resolveEnvFile(platform: NodeJS.Platform = process.platform, env: Env = process.env, home = homedir()): string {
  if (env.GATEWAY_ENV_FILE) return resolve(env.GATEWAY_ENV_FILE);
  return join(defaultDataDir(platform, env, home), "gateway.env");
}

export function readEnvFile(file: string): Env {
  if (!existsSync(file)) return {};
  return parseEnv(readFileSync(file, "utf8"));
}

export function loadConfig(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): GatewayConfig {
  const envFile = resolveEnvFile(platform, env, home);
  const merged: Env = { ...readEnvFile(envFile), ...definedOnly(env) };

  const adminPassword = merged.ADMIN_PASSWORD ?? "";
  if (!adminPassword) throw new Error(`ADMIN_PASSWORD is required (set it in ${envFile})`);

  const dataDir = resolve(merged.DATA_DIR || defaultDataDir(platform, env, home));
  return {
    envFile,
    host: merged.HOST || "127.0.0.1",
    port: toPort(merged.PORT, DEFAULT_PORT),
    dataDir,
    dbPath: join(dataDir, "gateway.db"),
    logDir: join(dataDir, "logs"),
    webDir: resolve(merged.WEB_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "public")),
    adminPassword,
    cookieSecure: merged.COOKIE_SECURE !== "false",
    workspaceRoots: (merged.WORKSPACE_ROOTS ?? "")
      .split(delimiter)
      .map((item) => item.trim())
      .filter(Boolean),
    cursorApiKey: merged.CURSOR_API_KEY || undefined,
    opencode: {
      enabled: merged.OPENCODE_ENABLE === "true",
      port: toPort(merged.OPENCODE_PORT, DEFAULT_OPENCODE_PORT),
      password: merged.OPENCODE_SERVER_PASSWORD || undefined,
    },
    fakeRuntime: merged.AGENT_RUNTIME === "fake",
    dispatchIntervalMs: toInterval(merged.DISPATCH_INTERVAL_MS, 60_000),
    workflowModel: merged.WORKFLOW_MODEL || "auto",
  };
}

export function applyEnvFile(config: GatewayConfig, env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(readEnvFile(config.envFile))) {
    if (env[key] === undefined && value !== undefined) env[key] = value;
  }
}

function definedOnly(env: Env): Env {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ""));
}

function toInterval(value: string | undefined, fallback: number): number {
  const ms = Number(value);
  return Number.isInteger(ms) && ms >= 1000 ? ms : fallback;
}

function toPort(value: string | undefined, fallback: number): number {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}

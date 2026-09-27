import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultDataDir, loadConfig, resolveEnvFile } from "../src/config.js";

describe("配置读取", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("Windows 和 macOS 的默认数据目录", () => {
    expect(defaultDataDir("win32", { LOCALAPPDATA: "C:\\Users\\tom\\AppData\\Local" }, "C:\\Users\\tom")).toBe(
      join("C:\\Users\\tom\\AppData\\Local", "TomsGateway"),
    );
    expect(defaultDataDir("darwin", {}, "/Users/tom")).toBe(join("/Users/tom", "Library", "Application Support", "TomsGateway"));
  });

  it("优先使用 GATEWAY_ENV_FILE，否则用数据目录下的 gateway.env", () => {
    expect(resolveEnvFile("darwin", { GATEWAY_ENV_FILE: "/tmp/custom.env" }, "/Users/tom")).toBe(resolve("/tmp/custom.env"));
    expect(resolveEnvFile("darwin", {}, "/Users/tom")).toBe(
      join("/Users/tom", "Library", "Application Support", "TomsGateway", "gateway.env"),
    );
  });

  it("从 gateway.env 读取配置，进程环境变量优先", async () => {
    dir = await mkdtemp(join(tmpdir(), "gw-cfg-"));
    const file = join(dir, "gateway.env");
    await writeFile(file, "ADMIN_PASSWORD=from-file\nPORT=4000\nCOOKIE_SECURE=false\nOPENCODE_ENABLE=true\n");
    const config = loadConfig({ GATEWAY_ENV_FILE: file, PORT: "4100" }, "darwin", dir);
    expect(config.adminPassword).toBe("from-file");
    expect(config.port).toBe(4100);
    expect(config.cookieSecure).toBe(false);
    expect(config.opencode).toMatchObject({ enabled: true, port: 3702 });
  });

  it("默认端口是 3701，只监听本机", async () => {
    dir = await mkdtemp(join(tmpdir(), "gw-cfg-"));
    const config = loadConfig({ GATEWAY_ENV_FILE: join(dir, "missing.env"), ADMIN_PASSWORD: "x" }, "darwin", dir);
    expect(config.port).toBe(3701);
    expect(config.host).toBe("127.0.0.1");
    expect(config.dataDir).toBe(resolve(dir, "Library", "Application Support", "TomsGateway"));
  });

  it("缺少 ADMIN_PASSWORD 时报错", async () => {
    dir = await mkdtemp(join(tmpdir(), "gw-cfg-"));
    expect(() => loadConfig({ GATEWAY_ENV_FILE: join(dir, "none.env") }, "darwin", dir)).toThrow(/ADMIN_PASSWORD/);
  });
});

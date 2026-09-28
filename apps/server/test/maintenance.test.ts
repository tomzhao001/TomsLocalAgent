import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db.js";
import { backupDatabase, cleanupLogs } from "../src/files.js";
import { ensureOpenCode, isDangerousCommand, isStalled, modelForRunningStep, snapshotConfig } from "../src/maintenance.js";

describe("收尾规则", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("改全局默认值不会改已经创建的工作流配置", () => {
    const created = snapshotConfig({ models: { develop: "composer-a" } });
    const saved = JSON.parse(JSON.stringify(created));
    snapshotConfig({ models: { develop: "composer-b" }, reviewRejectLimit: 9 });
    expect(saved.models.develop).toBe("composer-a");
    expect(saved.reviewRejectLimit).toBe(3);
  });

  it("节点模型修改不影响正在跑的那一步", () => {
    const config = snapshotConfig(null);
    config.models.develop = "new-model";
    expect(modelForRunningStep("old-model", config, "develop")).toBe("old-model");
  });

  it("超时后视为可恢复的失败", () => {
    expect(isStalled(0, 10_000, 5_000)).toBe(true);
    expect(isStalled(9_000, 10_000, 5_000)).toBe(false);
  });

  it("拦截强制推送和 rm -rf", () => {
    expect(isDangerousCommand("git push --force origin main")).toBe(true);
    expect(isDangerousCommand("rm -rf /")).toBe(true);
    expect(isDangerousCommand("git push origin main")).toBe(false);
  });

  it("健康检查失败时重新拉起 OpenCode", async () => {
    let restarted = 0;
    await ensureOpenCode(async () => false, async () => {
      restarted += 1;
    });
    await ensureOpenCode(async () => true, async () => {
      restarted += 1;
    });
    expect(restarted).toBe(1);
  });

  it("备份数据库并清理过期日志", async () => {
    dir = await mkdtemp(join(tmpdir(), "gw-keep-"));
    const db = openDatabase(join(dir, "gateway.db"));
    db.close();
    const backup = backupDatabase(join(dir, "gateway.db"), dir);
    expect(backup).toContain("gateway-");
    const logs = join(dir, "logs");
    await mkdir(logs);
    await writeFile(join(logs, "old.ndjson"), "x");
    expect(cleanupLogs(logs, -1)).toBe(1);
  });
});

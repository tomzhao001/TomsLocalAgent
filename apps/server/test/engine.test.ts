import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { discoverWorkflows } from "../src/workflows/_framework/registry.js";
import { acceptRequirements } from "../src/workflows/_framework/split.js";
import { runLoop } from "../src/workflows/_framework/engine.js";
import { WorkspaceLockManager } from "../src/locks.js";
import { openDatabase } from "../src/db.js";
import type { LoopAction, LoopEvent } from "../src/workflows/cursor-dev-loop/next.js";

const passing = async (action: Extract<LoopAction, { kind: "runStep" }>): Promise<LoopEvent> => {
  if (action.nodeId === "develop") return { type: "stepOk" };
  if (action.nodeId === "arch") return { type: "review", pass: true };
  if (action.nodeId === "qa") return { type: "qa", pass: true };
  return { type: "devops", results: [true] };
};

describe("工作流引擎", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("假执行器跑完两张卡", async () => {
    const seen: number[] = [];
    const result = await runLoop({
      cardCount: 2,
      execute: async (action) => {
        if (action.nodeId === "develop") seen.push(action.cardIndex);
        return passing(action);
      },
    });
    expect(seen).toEqual([0, 1]);
    expect(result.status).toBe("done");
  });

  it("架构第 4 次不通过停在 waiting_input 且不释放锁", async () => {
    dir = await mkdtemp(join(tmpdir(), "gw-eng-"));
    const db = openDatabase(join(dir, "gateway.db"));
    const locks = new WorkspaceLockManager(db);
    expect(locks.tryAcquire("ws", { type: "workflow", id: "wf" }).ok).toBe(true);
    const result = await runLoop({
      cardCount: 1,
      execute: async (action) => {
        if (action.nodeId === "arch") return { type: "review", pass: false };
        return { type: "stepOk" };
      },
    });
    expect(result.status).toBe("waiting_input");
    expect(result.state.archRejects).toBe(4);
    expect(locks.tryAcquire("ws", { type: "run", id: "other" }).ok).toBe(false);
    db.close();
  });

  it("重启后从暂停的步骤继续，而不是从头", async () => {
    const paused = await runLoop({
      cardCount: 1,
      execute: async (action) => (action.nodeId === "arch" ? { type: "review", pass: false } : { type: "stepOk" }),
    });
    let calls = 0;
    const resumed = await runLoop({
      cardCount: 1,
      resume: paused.state,
      execute: async () => {
        calls += 1;
        return { type: "stepOk" };
      },
    });
    expect(calls).toBe(0);
    expect(resumed.state.archRejects).toBe(4);
    expect(resumed.state.index).toBe(0);
  });

  it("注册表发现 cursor-dev-loop，忽略没有 index.ts 的目录", async () => {
    const root = fileURLToPath(new URL("../src/workflows/", import.meta.url));
    const found = await discoverWorkflows(root);
    expect(found.map((item) => item.id)).toContain("cursor-dev-loop");
    dir = await mkdtemp(join(tmpdir(), "gw-reg-"));
    await mkdir(join(dir, "notes"));
    await writeFile(join(dir, "notes", "readme.txt"), "no");
    expect(await discoverWorkflows(dir)).toEqual([]);
  });

  it("拆卡校验失败时返回给模型的错误", () => {
    const bad = acceptRequirements({ sharedContext: "背景", cards: [{ title: "缺字段" }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.length).toBeGreaterThan(0);
    const good = acceptRequirements({
      sharedContext: "只改文案",
      cards: [{ title: "标题", goal: "改文案", context: "首页", acceptanceCriteria: ["文案更新"] }],
    });
    expect(good.ok).toBe(true);
  });
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { discoverWorkflows } from "../src/workflows/_framework/registry.js";
import { acceptRequirements } from "../src/workflows/_framework/split.js";
import { parseResultBlock, stepTools, toLoopEvent, type StepResult } from "../src/workflows/_framework/result.js";

describe("工作流框架", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
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

  it("submit_verdict 和 ask_user 记录结果，参数不对时报错", async () => {
    const seen: StepResult[] = [];
    const tools = stepTools((result) => seen.push(result));
    await tools.submit_verdict!.execute({ verdict: "reject", comments: "命名不清" });
    await tools.ask_user!.execute({ question: "用哪个数据库？" });
    const bad = await tools.submit_verdict!.execute({ verdict: "maybe" });
    expect(seen).toEqual([
      { verdict: "reject", comments: "命名不清" },
      { verdict: "need_input", question: "用哪个数据库？" },
    ]);
    expect(bad).toMatchObject({ isError: true });
  });

  it("文本结果块兜底，结果按步骤转成状态机事件", () => {
    const parsed = parseResultBlock(['做完了\n<gateway-result>{"verdict":"pass","comments":"ok"}</gateway-result>']);
    expect(parsed).toEqual({ verdict: "pass", comments: "ok" });
    expect(parseResultBlock(["没有结果块"])).toBeNull();
    expect(toLoopEvent("develop", parsed)).toEqual({ type: "stepOk" });
    expect(toLoopEvent("arch", { verdict: "reject", comments: "" })).toEqual({ type: "review", pass: false });
    expect(toLoopEvent("qa", { verdict: "pass", comments: "" })).toEqual({ type: "qa", pass: true });
    expect(toLoopEvent("devops", { verdict: "reject", comments: "" })).toEqual({ type: "devops", results: [false] });
    expect(toLoopEvent("develop", { verdict: "need_input", question: "?" })).toEqual({ type: "needInput", question: "?" });
    expect(toLoopEvent("qa", null)).toEqual({ type: "techError" });
  });
});

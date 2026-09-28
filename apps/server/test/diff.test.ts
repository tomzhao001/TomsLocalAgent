import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { collectReviewDiff } from "../src/workflows/cursor-dev-loop/diff.js";

const exec = promisify(execFile);

describe("Review diff", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("带上未跟踪源文件，过长时只留路径", async () => {
    dir = await mkdtemp(join(tmpdir(), "gw-diff-"));
    await exec("git", ["init"], { cwd: dir, windowsHide: true });
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "short.ts"), "export const n = 1;\n");
    const short = await collectReviewDiff([dir]);
    expect(short).toContain("short.ts");
    expect(short).toContain("export const n = 1;");

    const bulky = "x".repeat(30_000);
    for (let i = 0; i < 4; i++) await writeFile(join(dir, "src", `big-${i}.ts`), bulky);
    const limited = await collectReviewDiff([dir]);
    expect(limited).toContain("改动超过长度上限");
    expect(limited).toContain("src/big-0.ts");
    expect(limited).not.toContain(bulky);
  });

  it("没有仓库时说明无法提供 diff", async () => {
    expect(await collectReviewDiff([])).toContain("没有发现 git 仓库");
  });
});

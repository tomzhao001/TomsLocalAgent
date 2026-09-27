import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendLog, readLog } from "../src/logs.js";

describe("NDJSON 日志", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("按字节 offset 分段读取，不丢不重", async () => {
    dir = await mkdtemp(join(tmpdir(), "gw-log-"));
    const file = join(dir, "run.ndjson");
    const events = [
      { type: "text" as const, text: "第一段" },
      { type: "thinking" as const, text: "想一下" },
      { type: "tool-start" as const, callId: "c1", name: "read" },
      { type: "done" as const, status: "finished" as const },
    ];
    for (const event of events.slice(0, 2)) appendLog(file, event);
    const first = readLog(file, 0);
    expect(first.events).toEqual(events.slice(0, 2));

    for (const event of events.slice(2)) appendLog(file, event);
    const second = readLog(file, first.nextOffset);
    expect(second.events).toEqual(events.slice(2));
    expect([...first.events, ...second.events]).toEqual(events);

    writeFileSync(file, "", { flag: "a" });
    const again = readLog(file, second.nextOffset);
    expect(again.events).toEqual([]);
    expect(again.nextOffset).toBe(second.nextOffset);
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { chatTranscript } from "../src/chat-history.js";
import { openDatabase } from "../src/db.js";
import { appendLog, logFile } from "../src/logs.js";

describe("聊天记录", () => {
  let dir: string;
  let db: DatabaseSync | undefined;

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function seed() {
    dir = await mkdtemp(join(tmpdir(), "gw-history-"));
    const logDir = join(dir, "logs");
    db = openDatabase(join(dir, "gateway.db"));
    const insert = db.prepare("INSERT INTO runs (id, workspace_id, session_id, status, prompt, created_at) VALUES (?, 'w', 's', 'finished', ?, ?)");
    insert.run("r1", "一", 1);
    insert.run("r2", "二", 2);
    insert.run("r3", "三", 3);
    appendLog(logFile(logDir, "s", "r1"), { type: "text", text: "答" });
    appendLog(logFile(logDir, "s", "r1"), { type: "tool-start", callId: "c1", name: "read" });
    appendLog(logFile(logDir, "s", "r1"), { type: "text", text: "一" });
    appendLog(logFile(logDir, "s", "r2"), { type: "text", text: "答二" });
    return { db, logDir };
  }

  it("按轮次拼出问答，只取正文", async () => {
    const { db, logDir } = await seed();
    expect(chatTranscript(db, logDir, "s")).toBe("用户：一\n\n助手：答一\n\n用户：二\n\n助手：答二\n\n用户：三");
  });

  it("跳过当前这一轮", async () => {
    const { db, logDir } = await seed();
    expect(chatTranscript(db, logDir, "s", { excludeRunId: "r3" })).toBe("用户：一\n\n助手：答一\n\n用户：二\n\n助手：答二");
  });

  it("超长时从最旧的轮次开始丢，单轮仍超长就截掉开头", async () => {
    const { db, logDir } = await seed();
    expect(chatTranscript(db, logDir, "s", { excludeRunId: "r3", maxChars: 11 })).toBe("用户：二\n\n助手：答二");
    expect(chatTranscript(db, logDir, "s", { excludeRunId: "r3", maxChars: 5 })).toBe("助手：答二");
  });
});

import type { DatabaseSync } from "node:sqlite";
import { logFile, readLog } from "./logs.js";

export const chatRecallChars = 12000;

export function chatTranscript(
  db: DatabaseSync,
  logDir: string,
  sessionId: string,
  options: { excludeRunId?: string; maxChars?: number } = {},
): string {
  const runs = db
    .prepare("SELECT id, prompt FROM runs WHERE session_id = ? ORDER BY created_at")
    .all(sessionId) as { id: string; prompt: string | null }[];
  const rounds: string[] = [];
  for (const run of runs) {
    if (run.id === options.excludeRunId) continue;
    const lines: string[] = [];
    if (run.prompt) lines.push(`用户：${run.prompt}`);
    const { events } = readLog(logFile(logDir, sessionId, run.id), 0);
    const text = events
      .filter((event): event is { type: "text"; text: string } => event.type === "text")
      .map((event) => event.text)
      .join("");
    if (text) lines.push(`助手：${text}`);
    if (lines.length) rounds.push(lines.join("\n\n"));
  }
  const max = options.maxChars;
  if (!max) return rounds.join("\n\n");
  const kept: string[] = [];
  let size = 0;
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const round = rounds[index]!;
    const next = size + round.length + (kept.length ? 2 : 0);
    if (next > max && kept.length) break;
    kept.unshift(round);
    size = next;
  }
  const text = kept.join("\n\n");
  return text.length > max ? text.slice(-max) : text;
}

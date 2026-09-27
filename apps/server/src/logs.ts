import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { GatewayEvent } from "@gateway/shared";

export function appendLog(file: string, event: GatewayEvent): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(event)}\n`, "utf8");
}

export function logFile(logDir: string, sessionId: string, runId: string): string {
  return `${logDir}/${sessionId}/${runId}.ndjson`;
}

export function readLog(file: string, offset: number): { events: GatewayEvent[]; nextOffset: number } {
  let buf: Buffer;
  try {
    buf = readFileSync(file);
  } catch {
    return { events: [], nextOffset: offset };
  }
  if (offset >= buf.length) return { events: [], nextOffset: offset };
  const text = buf.subarray(offset).toString("utf8");
  const lastNl = text.lastIndexOf("\n");
  if (lastNl < 0) return { events: [], nextOffset: offset };
  const chunk = text.slice(0, lastNl + 1);
  const events = chunk
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as GatewayEvent);
  return { events, nextOffset: offset + Buffer.byteLength(chunk) };
}

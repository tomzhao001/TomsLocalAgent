import type { GatewayEvent, RunStatus } from "@gateway/shared";

export type LiveFrame = { id: number; event: GatewayEvent };

export type LiveStatus = Exclude<RunStatus, "running">;

export class LiveRun {
  readonly frames: LiveFrame[] = [];
  status: "running" | LiveStatus = "running";
  private readonly listeners = new Set<(frame: LiveFrame) => void>();
  private readonly endings = new Set<() => void>();

  publish(event: GatewayEvent, persist: () => void): LiveFrame {
    const frame = { id: this.frames.length + 1, event };
    this.frames.push(frame);
    for (const listener of this.listeners) listener(frame);
    persist();
    return frame;
  }

  finish(status: LiveStatus): void {
    if (this.status !== "running") return;
    this.status = status;
    const endings = [...this.endings];
    this.endings.clear();
    this.listeners.clear();
    for (const ending of endings) ending();
  }

  subscribe(after: number, onFrame: (frame: LiveFrame) => void, onEnd: () => void): () => void {
    for (const frame of this.frames) {
      if (frame.id > after) onFrame(frame);
    }
    if (this.status !== "running") {
      onEnd();
      return () => {};
    }
    const listener = (frame: LiveFrame) => {
      if (frame.id > after) onFrame(frame);
    };
    const ending = () => {
      this.listeners.delete(listener);
      onEnd();
    };
    this.listeners.add(listener);
    this.endings.add(ending);
    return () => {
      this.listeners.delete(listener);
      this.endings.delete(ending);
    };
  }
}

export function formatSse(id: number, event: GatewayEvent): string {
  return `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function eventCursor(after: unknown, lastEventId: unknown): number {
  return Math.max(positive(after), positive(lastEventId));
}

function positive(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

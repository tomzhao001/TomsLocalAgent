import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api, type LogEvent } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";

export function LogView({ url, running }: { url: string; running: boolean }) {
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const offset = useRef(0);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const current = seq.current;
    setLoading(true);
    try {
      const body = await api<{ events: LogEvent[]; nextOffset: number }>(`${url}?offset=${offset.current}`);
      if (current !== seq.current) return;
      offset.current = body.nextOffset;
      if (body.events.length) setEvents((items) => [...items, ...body.events]);
      setError("");
    } catch (reason) {
      if (current === seq.current) setError(reason instanceof Error ? reason.message : "日志读取失败");
    } finally {
      if (current === seq.current) setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    seq.current += 1;
    offset.current = 0;
    setEvents([]);
    void load();
  }, [load]);

  usePolling(load, 10_000, running);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{running ? "运行中，每 10 秒自动刷新" : "已结束"}</span>
        <Button type="button" size="icon-xs" variant="ghost" aria-label="刷新日志" disabled={loading} onClick={() => void load()}>
          <RefreshCw />
        </Button>
      </div>
      <ScrollArea className="max-h-80 rounded-lg border">
        <div className="flex flex-col gap-2 p-3 text-xs leading-5">
          {events.length === 0 ? <p className="text-muted-foreground">暂无日志</p> : null}
          {events.map((event, index) => (
            <LogLine key={index} event={event} />
          ))}
          {error ? <p className="text-destructive">{error}</p> : null}
        </div>
      </ScrollArea>
    </div>
  );
}

function LogLine({ event }: { event: LogEvent }) {
  if (event.type === "text") return <p className="whitespace-pre-wrap">{event.text}</p>;
  if (event.type === "thinking") {
    return (
      <details className="text-muted-foreground">
        <summary className="cursor-pointer">思考</summary>
        <p className="whitespace-pre-wrap">{event.text}</p>
      </details>
    );
  }
  if (event.type === "tool-start") return <p className="font-mono text-muted-foreground">→ {toolLine(event.name, event.detail)}</p>;
  if (event.type === "tool-end") return <p className="font-mono text-muted-foreground">✓ {toolLine(event.name, event.detail)}</p>;
  if (event.type === "plan") return <p className="text-muted-foreground">计划：{event.plan.name || event.plan.overview || "已生成"}</p>;
  if (event.type === "todos") return <p className="text-muted-foreground">待办 {event.todos.length} 项</p>;
  if (event.type === "error") return <p className="text-destructive">{event.message}</p>;
  if (event.type === "done") return <p className="text-muted-foreground">结束：{event.status}</p>;
  return null;
}

function toolLine(name: string, detail?: string): string {
  return detail ? `${name} ${detail}` : name;
}

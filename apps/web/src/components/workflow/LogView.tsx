import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api, type LogEvent } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import { appendLogEvent, type ChatBubble } from "@/pages/chat-log";

export function LogView({ url, running, scroll = true }: { url: string; running: boolean; scroll?: boolean }) {
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const offset = useRef(0);
  const seq = useRef(0);
  const bubbles = events.reduce(appendLogEvent, [] as ChatBubble[]);

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

  const body = (
    <div className={`flex min-w-0 max-w-full flex-col gap-2 text-[10px] leading-4 wrap-break-word ${scroll ? "p-3" : ""}`}>
      {bubbles.length === 0 ? <p className="text-muted-foreground">暂无日志</p> : null}
      {bubbles.map((bubble, index) => (
        <LogBubble key={index} bubble={bubble} />
      ))}
      {error ? <p className="text-destructive">{error}</p> : null}
    </div>
  );

  return (
    <div className="flex min-w-0 max-w-full flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{running ? "运行中，每 10 秒自动刷新" : "已结束"}</span>
        <Button type="button" size="icon-xs" variant="ghost" aria-label="刷新日志" disabled={loading} onClick={() => void load()}>
          <RefreshCw className={loading ? "animate-spin" : ""} />
        </Button>
      </div>
      {scroll ? <ScrollArea className="max-h-80 min-w-0 overflow-x-hidden rounded-lg border">{body}</ScrollArea> : body}
    </div>
  );
}

function LogBubble({ bubble }: { bubble: ChatBubble }) {
  if (bubble.role === "thinking") {
    return (
      <details className="text-muted-foreground">
        <summary className="cursor-pointer">思考</summary>
        <p className="wrap-break-word whitespace-pre-wrap">{bubble.text}</p>
      </details>
    );
  }
  if (bubble.role === "tool") {
    return (
      <p className="font-mono wrap-break-word text-muted-foreground">
        {bubble.running ? "→" : "✓"} {toolLine(bubble.name, bubble.detail)}
      </p>
    );
  }
  if (bubble.role === "plan") {
    const name = bubble.plan.name || bubble.plan.overview || "已生成";
    const todos = bubble.plan.todos.length ? ` · 待办 ${bubble.plan.todos.length} 项` : "";
    return (
      <p className="text-muted-foreground">
        计划：{name}
        {todos}
      </p>
    );
  }
  if (bubble.role === "error") return <p className="wrap-break-word whitespace-pre-wrap text-destructive">{bubble.text}</p>;
  if (bubble.role === "done") return <p className="text-muted-foreground">结束：{bubble.status}</p>;
  if (bubble.role === "assistant" || bubble.role === "user") return <p className="wrap-break-word whitespace-pre-wrap">{bubble.text}</p>;
  return null;
}

function toolLine(name: string, detail?: string): string {
  return detail ? `${name} ${detail}` : name;
}

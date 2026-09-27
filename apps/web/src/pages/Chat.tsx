import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";

type Workspace = { id: string; name: string; archived: boolean };
type Session = { id: string; provider: string; workspace_id: string; workspace_name: string; title: string | null };
type RunRow = { id: string; status: string; prompt: string | null };
type LogEvent = { type: string; text?: string; status?: string };
type ModelInfo = { id: string; label: string };
type Bubble = { role: "user" | "assistant"; text: string };

export function ChatPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [provider, setProvider] = useState("cursor");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState("");
  const [modelError, setModelError] = useState("");
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const loadSeq = useRef(0);

  const activeProvider = sessionId ? (sessions.find((item) => item.id === sessionId)?.provider ?? provider) : provider;

  async function reloadSessions() {
    const res = await fetch("/api/sessions", { credentials: "include" });
    if (res.ok) setSessions((await res.json()) as Session[]);
  }

  useEffect(() => {
    void fetch("/api/workspaces", { credentials: "include" })
      .then((res) => res.json())
      .then((items: Workspace[]) => setWorkspaces(items.filter((item) => !item.archived)));
    void reloadSessions();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setModelError("");
    void fetch(`/api/providers/${activeProvider}/models`, { credentials: "include" })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as ModelInfo[] | { message?: string };
        if (!res.ok) {
          const message = !Array.isArray(body) && body.message ? body.message : "模型列表读取失败";
          throw new Error(message);
        }
        return Array.isArray(body) ? body : [];
      })
      .then((items) => {
        if (cancelled) return;
        setModels(items);
        setModel((current) => {
          if (current && items.some((item) => item.id === current)) return current;
          return items.find((item) => item.id === "auto")?.id ?? items[0]?.id ?? "";
        });
        if (items.length === 0) setModelError("暂无模型");
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setModels([]);
        setModel("");
        setModelError(reason instanceof Error ? reason.message : "模型列表读取失败");
      });
    return () => {
      cancelled = true;
    };
  }, [activeProvider]);

  async function loadMessages(id: string, seq: number) {
    const runs = await fetch(`/api/sessions/${id}/runs`, { credentials: "include" });
    if (!runs.ok || seq !== loadSeq.current) return;
    const rows = (await runs.json()) as RunRow[];
    const next: Bubble[] = [];
    for (const run of rows) {
      if (seq !== loadSeq.current) return;
      if (run.prompt) next.push({ role: "user", text: run.prompt });
      const log = await fetch(`/api/runs/${run.id}/log?offset=0`, { credentials: "include" });
      if (seq !== loadSeq.current) return;
      const body = (await log.json()) as { events: LogEvent[] };
      for (const event of body.events) {
        if (event.type === "text" && event.text) next.push({ role: "assistant", text: event.text });
      }
    }
    if (seq !== loadSeq.current) return;
    setBubbles(next);
  }

  async function openSession(id: string) {
    setSessionId(id);
    setError("");
    setRefreshing(false);
    const seq = ++loadSeq.current;
    await loadMessages(id, seq);
  }

  async function refresh() {
    if (!sessionId) return;
    setRefreshing(true);
    setError("");
    const seq = ++loadSeq.current;
    try {
      await loadMessages(sessionId, seq);
    } finally {
      if (seq === loadSeq.current) setRefreshing(false);
    }
  }

  async function createSession() {
    setError("");
    const res = await fetch("/api/sessions", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, workspaceId }),
    });
    const body = (await res.json()) as { id?: string; message?: string };
    if (!res.ok || !body.id) {
      setError(body.message ?? "创建失败");
      return;
    }
    await reloadSessions();
    await openSession(body.id);
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sessionId || !model) return;
    setError("");
    const text = String(new FormData(event.currentTarget).get("prompt") ?? "");
    const seq = loadSeq.current;
    const res = await fetch(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: text, model }),
    });
    const body = (await res.json()) as { runId?: string; message?: string };
    if (seq !== loadSeq.current) return;
    if (!res.ok || !body.runId) {
      setError(body.message ?? "发送失败");
      return;
    }
    setPrompt("");
    setBubbles((current) => [...current, { role: "user", text }]);
    let offset = 0;
    for (let i = 0; i < 30; i++) {
      if (seq !== loadSeq.current) return;
      const log = await fetch(`/api/runs/${body.runId}/log?offset=${offset}`, { credentials: "include" });
      if (seq !== loadSeq.current) return;
      const payload = (await log.json()) as { events: LogEvent[]; nextOffset: number; status: string };
      if (payload.events.length) {
        const texts = payload.events.filter((item) => item.type === "text" && item.text).map((item) => item.text!);
        if (texts.length && seq === loadSeq.current) {
          setBubbles((current) => [...current, ...texts.map((line) => ({ role: "assistant" as const, text: line }))]);
        }
        offset = payload.nextOffset;
      }
      if (payload.status !== "running") break;
      if (document.visibilityState === "hidden") break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  return (
    <section className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <Card className="min-h-0">
        <CardHeader>
          <CardTitle>聊天</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid gap-2">
            <Label>Workspace</Label>
            <Select value={workspaceId} onValueChange={setWorkspaceId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="请选择" />
              </SelectTrigger>
              <SelectContent>
                {workspaces.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>模式</Label>
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cursor">Cursor</SelectItem>
                <SelectItem value="opencode">OpenCode</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button type="button" onClick={() => void createSession()} disabled={!workspaceId}>
            新建聊天
          </Button>
          <Separator />
          <ScrollArea className="h-64">
            <ul className="flex flex-col gap-1 pr-3">
              {sessions.map((item) => (
                <li key={item.id}>
                  <Button
                    type="button"
                    variant={sessionId === item.id ? "secondary" : "ghost"}
                    className="h-auto w-full justify-start px-2 py-1.5 whitespace-normal"
                    onClick={() => void openSession(item.id)}
                  >
                    {item.workspace_name} / {item.provider}
                  </Button>
                </li>
              ))}
            </ul>
          </ScrollArea>
        </CardContent>
      </Card>
      <Card className="flex min-h-[32rem] flex-col">
        <CardHeader>
          <CardTitle>消息</CardTitle>
          {sessionId ? <CardDescription>当前聊天已绑定 workspace 和模式，不能再改。</CardDescription> : null}
          <CardAction>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="刷新"
              disabled={!sessionId || refreshing}
              onClick={() => void refresh()}
            >
              <RefreshCw />
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
          <ScrollArea className="min-h-48 flex-1 rounded-lg border">
            <div className="flex flex-col gap-3 p-3">
              {bubbles.map((bubble, index) => (
                <p
                  key={index}
                  className={
                    bubble.role === "user"
                      ? "ml-auto max-w-[80%] rounded-2xl bg-primary px-3 py-2 text-sm leading-6 text-primary-foreground"
                      : "mr-auto max-w-[80%] rounded-2xl bg-muted px-3 py-2 text-sm leading-6"
                  }
                >
                  {bubble.text}
                </p>
              ))}
            </div>
          </ScrollArea>
          <form className="flex flex-col gap-2" onSubmit={(event) => void send(event)}>
            <Textarea name="prompt" value={prompt} placeholder="输入消息" onChange={(e) => setPrompt(e.target.value)} />
            <div className="flex items-center justify-end gap-2">
              <Select value={model} onValueChange={setModel} disabled={models.length === 0}>
                <SelectTrigger className="w-48">
                  <SelectValue placeholder="暂无模型" />
                </SelectTrigger>
                <SelectContent>
                  {models.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="submit" disabled={!sessionId || !model}>
                发送
              </Button>
            </div>
          </form>
          {modelError ? (
            <Alert>
              <AlertDescription>{modelError}</AlertDescription>
            </Alert>
          ) : null}
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}

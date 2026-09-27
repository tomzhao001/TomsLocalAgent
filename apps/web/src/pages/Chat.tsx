import { useEffect, useState, type FormEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";

type Workspace = { id: string; name: string; archived: boolean };
type Session = { id: string; provider: string; workspace_id: string; workspace_name: string; title: string | null };
type RunRow = { id: string; status: string };
type LogEvent = { type: string; text?: string; status?: string };

export function ChatPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [provider, setProvider] = useState("cursor");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState("");

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

  async function openSession(id: string) {
    setSessionId(id);
    setError("");
    const runs = await fetch(`/api/sessions/${id}/runs`, { credentials: "include" });
    const rows = (await runs.json()) as RunRow[];
    const texts: string[] = [];
    for (const run of rows) {
      const log = await fetch(`/api/runs/${run.id}/log?offset=0`, { credentials: "include" });
      const body = (await log.json()) as { events: LogEvent[] };
      for (const event of body.events) {
        if (event.type === "text" && event.text) texts.push(event.text);
      }
    }
    setLines(texts);
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
    if (!sessionId) return;
    setError("");
    const text = String(new FormData(event.currentTarget).get("prompt") ?? "");
    const res = await fetch(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: text, model: model || "auto" }),
    });
    const body = (await res.json()) as { runId?: string; message?: string };
    if (!res.ok || !body.runId) {
      setError(body.message ?? "发送失败");
      return;
    }
    setPrompt("");
    let offset = 0;
    for (let i = 0; i < 30; i++) {
      const log = await fetch(`/api/runs/${body.runId}/log?offset=${offset}`, { credentials: "include" });
      const payload = (await log.json()) as { events: LogEvent[]; nextOffset: number; status: string };
      if (payload.events.length) {
        setLines((current) => [
          ...current,
          ...payload.events.filter((item) => item.type === "text" && item.text).map((item) => item.text!),
        ]);
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
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
          <ScrollArea className="min-h-48 flex-1 rounded-lg border">
            <div className="flex flex-col gap-3 p-3">
              {lines.map((line, index) => (
                <p key={index} className="text-sm leading-6">
                  {line}
                </p>
              ))}
            </div>
          </ScrollArea>
          <form className="flex flex-col gap-2" onSubmit={(event) => void send(event)}>
            <Input name="model" value={model} placeholder="模型" onChange={(e) => setModel(e.target.value)} />
            <Textarea name="prompt" value={prompt} placeholder="输入消息" onChange={(e) => setPrompt(e.target.value)} />
            <Button type="submit" className="self-end" disabled={!sessionId}>
              发送
            </Button>
          </form>
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

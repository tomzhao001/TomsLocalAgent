import { useEffect, useState, type FormEvent } from "react";

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
    <section>
      <h2>聊天</h2>
      <label>
        Workspace
        <select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
          <option value="">请选择</option>
          {workspaces.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        模式
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="cursor">Cursor</option>
          <option value="opencode">OpenCode</option>
        </select>
      </label>
      <button type="button" onClick={() => void createSession()} disabled={!workspaceId}>
        新建聊天
      </button>
      <ul>
        {sessions.map((item) => (
          <li key={item.id}>
            <button type="button" onClick={() => void openSession(item.id)}>
              {item.workspace_name} / {item.provider}
            </button>
          </li>
        ))}
      </ul>
      {sessionId ? <p>当前聊天已绑定 workspace 和模式，不能再改。</p> : null}
      <div>
        {lines.map((line, index) => (
          <p key={index}>{line}</p>
        ))}
      </div>
      <form onSubmit={(event) => void send(event)}>
        <input name="model" value={model} placeholder="模型" onChange={(e) => setModel(e.target.value)} />
        <input name="prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <button type="submit" disabled={!sessionId}>
          发送
        </button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

import { GitBranchPlus, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SplitDialog } from "@/components/workflow/SplitDialog";
import { readonlyViolation, type LogEvent, type PlanDocument, type PlanTodo } from "@/lib/api";
import { appendLogEvent, todoLabel, type ChatBubble } from "./chat-log";

type Session = {
  id: string;
  provider: string;
  workspace_id: string;
  workspace_name: string;
  title: string | null;
  created_at?: number | null;
};
type RunRow = { id: string; status: string; prompt: string | null };
type ModelInfo = { id: string; label: string };
type Bubble = ChatBubble;

const providerLabels: Record<string, string> = { cursor: "Cursor", opencode: "OpenCode" };
const recentLimit = 10;

export function cursorChatTitle(createdAt?: number | null): string {
  if (!createdAt) return "Cursor 聊天";
  const date = new Date(createdAt);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `Cursor 聊天 ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function sessionLabel(item: Session): string {
  if (item.title) return item.title;
  if (item.provider === "cursor") return cursorChatTitle(item.created_at);
  return providerLabels[item.provider] ?? item.provider;
}

export function ChatPage({
  workspaceId,
  chatModel = "",
  onSplitStarted,
  onToolbar,
}: {
  workspaceId: string;
  chatModel?: string;
  onSplitStarted: () => void;
  onToolbar?: (node: ReactNode | null) => void;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [provider, setProvider] = useState("cursor");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState("");
  const [chatMode, setChatMode] = useState<"ask" | "plan" | "agent">("agent");
  const [modelError, setModelError] = useState("");
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [error, setError] = useState("");
  const loadSeq = useRef(0);
  const watchStop = useRef<(() => void) | null>(null);
  const liveEvents = useRef<LogEvent[]>([]);
  const createSessionRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => () => watchStop.current?.(), []);

  const activeProvider = sessionId ? (sessions.find((item) => item.id === sessionId)?.provider ?? provider) : provider;

  async function reloadSessions() {
    const res = await fetch(`/api/sessions?workspaceId=${encodeURIComponent(workspaceId)}`, { credentials: "include" });
    if (res.ok) setSessions((await res.json()) as Session[]);
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/sessions?workspaceId=${encodeURIComponent(workspaceId)}`, { credentials: "include" });
      if (!res.ok || cancelled) return;
      const rows = (await res.json()) as Session[];
      if (cancelled) return;
      setSessions(rows);
      const latest = rows[0];
      if (!latest) return;
      const seq = ++loadSeq.current;
      setSessionId(latest.id);
      setError("");
      setRefreshing(false);
      await loadMessages(latest.id, seq);
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

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
        const listed = withChatModel(items, chatModel);
        setModels(listed);
        setModel((current) => {
          if (current && listed.some((item) => item.id === current)) return current;
          if (chatModel) return chatModel;
          return listed.find((item) => item.id === "auto")?.id ?? listed[0]?.id ?? "";
        });
        if (listed.length === 0) setModelError("暂无模型");
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setModels(chatModel ? [{ id: chatModel, label: chatModel }] : []);
        setModel(chatModel);
        if (!chatModel) setModelError(reason instanceof Error ? reason.message : "模型列表读取失败");
      });
    return () => {
      cancelled = true;
    };
  }, [activeProvider, chatModel]);

  function closeWatch() {
    watchStop.current?.();
    watchStop.current = null;
  }

  function follow(session: string, runId: string, seq: number) {
    closeWatch();
    if (seq !== loadSeq.current) return;
    setActiveRunId(runId);
    liveEvents.current = [];
    const source = new EventSource(`/api/runs/${runId}/events`, { withCredentials: true });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      source.close();
      if (watchStop.current === finish) watchStop.current = null;
      if (seq === loadSeq.current) setActiveRunId((current) => (current === runId ? null : current));
    };
    source.onmessage = (message) => {
      if (seq !== loadSeq.current || settled) return;
      const event = JSON.parse(message.data) as LogEvent;
      liveEvents.current.push(event);
      if (event.type === "done") {
        const events = liveEvents.current;
        setBubbles((current) => [...current, roundEnd(runId, event.status, events)]);
        finish();
        return;
      }
      setBubbles((current) => appendLogEvent(current, event));
    };
    source.onerror = () => {
      if (settled || seq !== loadSeq.current || source.readyState !== EventSource.CLOSED) return;
      finish();
      void loadMessages(session, seq, true);
    };
    watchStop.current = finish;
  }

  async function loadMessages(id: string, seq: number, archiveOnly = false) {
    closeWatch();
    setActiveRunId(null);
    const runs = await fetch(`/api/sessions/${id}/runs`, { credentials: "include" });
    if (!runs.ok || seq !== loadSeq.current) return;
    const rows = (await runs.json()) as RunRow[];
    let next: Bubble[] = [];
    for (const run of rows) {
      if (seq !== loadSeq.current) return;
      if (run.prompt) next.push({ role: "user", text: run.prompt });
      if (run.status === "running" && !archiveOnly) {
        if (seq !== loadSeq.current) return;
        setBubbles(next);
        follow(id, run.id, seq);
        return;
      }
      const log = await fetch(`/api/runs/${run.id}/log?offset=0`, { credentials: "include" });
      if (seq !== loadSeq.current) return;
      const body = (await log.json()) as { events: LogEvent[]; status: string };
      next = body.events.reduce(appendLogEvent, next);
      next.push(roundEnd(run.id, body.status, body.events));
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

  createSessionRef.current = createSession;

  useEffect(() => {
    onToolbar?.(<ChatToolbar provider={provider} onProvider={setProvider} onCreate={() => void createSessionRef.current()} />);
    return () => onToolbar?.(null);
  }, [provider, onToolbar]);

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
      body: JSON.stringify({ prompt: text, model, ...(activeProvider === "cursor" ? { mode: chatMode } : {}) }),
    });
    const body = (await res.json()) as { runId?: string; message?: string };
    if (seq !== loadSeq.current) return;
    if (!res.ok || !body.runId) {
      setError(body.message ?? "发送失败");
      return;
    }
    setPrompt("");
    setBubbles((current) => [...current, { role: "user", text }]);
    follow(sessionId, body.runId, seq);
  }

  async function stop() {
    if (!activeRunId) return;
    const res = await fetch(`/api/runs/${activeRunId}/cancel`, { method: "POST", credentials: "include" });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      setError(body.message ?? "终止失败");
    }
  }

  const recent = sessions.slice(0, recentLimit);
  const modeHint =
    activeProvider === "cursor" && chatMode === "agent"
      ? "Agent 会直接修改这个 workspace 里的文件。"
      : "只读模式：聊天不会修改代码，改代码请转为工作流。";

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <Card className="flex min-h-0 flex-1 flex-col">
        <CardHeader className="shrink-0">
          <CardTitle className="flex items-center gap-2">
            消息
            <Select value={sessionId ?? ""} onValueChange={(id) => { if (id) void openSession(id); }} disabled={recent.length === 0}>
              <SelectTrigger className="w-72 font-normal" aria-label="最近聊天">
                <SelectValue placeholder="还没有聊天" />
              </SelectTrigger>
              <SelectContent>
                {recent.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {sessionLabel(item)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardTitle>
          <CardDescription>{modeHint}</CardDescription>
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
          <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border">
            <div className="flex flex-col gap-3 p-3">
              {bubbles.map((bubble, index) =>
                bubble.role === "end" ? (
                  <div key={index} className="flex flex-wrap items-center gap-2">
                    {bubble.violation ? (
                      <span className="flex items-center gap-1 text-xs text-destructive">
                        <TriangleAlert className="size-3.5" />
                        {readonlyViolation}
                      </span>
                    ) : null}
                    {bubble.finished ? (
                      <Button type="button" size="xs" variant="outline" onClick={() => setSplitOpen(true)}>
                        <GitBranchPlus data-icon="inline-start" />
                        转为工作流
                      </Button>
                    ) : null}
                  </div>
                ) : bubble.role === "plan" ? (
                  <PlanCard key={index} plan={bubble.plan} />
                ) : bubble.role === "thinking" ? (
                  <details key={index} className="mr-auto max-w-[80%] text-sm leading-6 text-muted-foreground">
                    <summary className="cursor-pointer text-xs">思考</summary>
                    <p className="whitespace-pre-wrap">{bubble.text}</p>
                  </details>
                ) : bubble.role === "tool" ? (
                  <details key={index} className="mr-auto text-xs leading-5 text-muted-foreground">
                    <summary className="cursor-pointer">
                      {bubble.running ? "正在使用" : "已使用"} {bubble.name}
                    </summary>
                    {bubble.detail ? <p className="whitespace-pre-wrap">{bubble.detail}</p> : null}
                  </details>
                ) : (
                  <p
                    key={index}
                    className={
                      bubble.role === "user"
                        ? "ml-auto max-w-[80%] rounded-2xl bg-primary px-3 py-2 text-sm leading-6 whitespace-pre-wrap text-primary-foreground"
                        : bubble.role === "error"
                          ? "mr-auto max-w-[80%] text-sm leading-6 whitespace-pre-wrap text-destructive"
                          : "mr-auto max-w-[80%] rounded-2xl bg-muted px-3 py-2 text-sm leading-6 whitespace-pre-wrap"
                    }
                  >
                    {bubble.text}
                  </p>
                ),
              )}
              {activeRunId ? <p className="animate-pulse text-xs text-muted-foreground">正在处理…</p> : null}
            </div>
          </div>
          <form className="flex shrink-0 flex-col gap-2" onSubmit={(event) => void send(event)}>
            <Textarea
              name="prompt"
              value={prompt}
              placeholder="输入消息"
              className="max-h-40 overflow-y-auto"
              onChange={(e) => setPrompt(e.target.value)}
            />
            <div className="flex items-center justify-end gap-2">
              {activeProvider === "cursor" ? (
                <Select
                  value={chatMode}
                  onValueChange={(value) => {
                    if (value === "plan" || value === "agent" || value === "ask") setChatMode(value);
                  }}
                >
                  <SelectTrigger className="w-28" aria-label="对话方式">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="agent">Agent</SelectItem>
                    <SelectItem value="ask">Ask</SelectItem>
                    <SelectItem value="plan">Plan</SelectItem>
                  </SelectContent>
                </Select>
              ) : null}
              <Select
                value={model}
                onValueChange={(value) => {
                  if (value) setModel(value);
                }}
                disabled={models.length === 0}
              >
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
              {activeRunId ? (
                <Button type="button" variant="outline" onClick={() => void stop()}>
                  终止
                </Button>
              ) : (
                <Button type="submit" disabled={!sessionId || !model}>
                  发送
                </Button>
              )}
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
      {sessionId ? (
        <SplitDialog
          open={splitOpen}
          onOpenChange={setSplitOpen}
          workspaceId={workspaceId}
          chatSessionId={sessionId}
          onStarted={onSplitStarted}
        />
      ) : null}
    </section>
  );
}

function ChatToolbar({
  provider,
  onProvider,
  onCreate,
}: {
  provider: string;
  onProvider: (value: string) => void;
  onCreate: () => void;
}) {
  return (
    <div className="ml-auto flex items-center gap-2">
      <Select value={provider} onValueChange={(value) => { if (value) onProvider(value); }}>
        <SelectTrigger className="w-32" aria-label="模式">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="cursor">Cursor</SelectItem>
          <SelectItem value="opencode">OpenCode</SelectItem>
        </SelectContent>
      </Select>
      <Button type="button" size="sm" onClick={onCreate}>
        新建聊天
      </Button>
    </div>
  );
}

function withChatModel(items: ModelInfo[], chatModel: string): ModelInfo[] {
  if (!chatModel || items.some((item) => item.id === chatModel)) return items;
  return [{ id: chatModel, label: chatModel }, ...items];
}

function PlanCard({ plan }: { plan: PlanDocument }) {
  return (
    <div className="mr-auto flex w-full max-w-[80%] flex-col gap-2 rounded-2xl border px-3 py-2 text-sm leading-6">
      <p className="font-medium">{plan.name || "计划"}</p>
      {plan.overview ? <p className="text-muted-foreground">{plan.overview}</p> : null}
      {plan.plan ? <p className="whitespace-pre-wrap">{plan.plan}</p> : null}
      <TodoList todos={plan.todos} />
      {plan.phases?.map((phase) => (
        <div key={phase.name} className="flex flex-col gap-1">
          <p className="font-medium">{phase.name}</p>
          <TodoList todos={phase.todos} />
        </div>
      ))}
    </div>
  );
}

function TodoList({ todos }: { todos: PlanTodo[] }) {
  if (todos.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {todos.map((todo) => (
        <li key={todo.id}>
          {todoLabel(todo.status)}：{todo.content}
        </li>
      ))}
    </ul>
  );
}

function roundEnd(runId: string, status: string, events: LogEvent[]): Bubble {
  return {
    role: "end",
    runId,
    finished: status === "finished",
    violation: events.some((event) => event.type === "error" && event.message === readonlyViolation),
  };
}

import type { LogEvent, PlanDocument, PlanTodo } from "@/lib/api";

export type ChatBubble =
  | { role: "user" | "assistant" | "error"; text: string }
  | { role: "thinking"; text: string }
  | { role: "tool"; callId: string; name: string; detail?: string; running: boolean }
  | { role: "plan"; plan: PlanDocument }
  | { role: "end"; runId: string; finished: boolean; violation: boolean };

const todoLabels: Record<PlanTodo["status"], string> = {
  pending: "待办",
  in_progress: "进行中",
  completed: "完成",
  cancelled: "取消",
};

export function todoLabel(status: PlanTodo["status"]): string {
  return todoLabels[status];
}

export function appendLogEvent(bubbles: ChatBubble[], event: LogEvent): ChatBubble[] {
  if (event.type === "text" && event.text) return appendText(bubbles, "assistant", event.text);
  if (event.type === "thinking" && event.text) return appendText(bubbles, "thinking", event.text);
  if (event.type === "tool-start") return applyTool(bubbles, event, true);
  if (event.type === "tool-end") return applyTool(bubbles, event, false);
  if (event.type === "error") return [...bubbles, { role: "error", text: event.message }];
  if (event.type === "plan") return [...bubbles, { role: "plan", plan: event.plan }];
  if (event.type === "todos") return applyTodos(bubbles, event.todos);
  return bubbles;
}

function appendText(bubbles: ChatBubble[], role: "assistant" | "thinking", text: string): ChatBubble[] {
  const last = bubbles.at(-1);
  if (last?.role === role) {
    const next = bubbles.slice(0, -1);
    next.push({ role, text: last.text + text });
    return next;
  }
  return [...bubbles, { role, text }];
}

function applyTool(
  bubbles: ChatBubble[],
  event: { callId: string; name: string; detail?: string },
  running: boolean,
): ChatBubble[] {
  const tool: ChatBubble = {
    role: "tool",
    callId: event.callId,
    name: event.name,
    ...(event.detail ? { detail: event.detail } : {}),
    running,
  };
  for (let index = bubbles.length - 1; index >= 0; index -= 1) {
    const item = bubbles[index];
    if (item?.role !== "tool" || item.callId !== event.callId) continue;
    const next = [...bubbles];
    next[index] = { ...tool, detail: event.detail ?? item.detail };
    return next;
  }
  return [...bubbles, tool];
}

function applyTodos(bubbles: ChatBubble[], todos: PlanTodo[]): ChatBubble[] {
  for (let index = bubbles.length - 1; index >= 0; index -= 1) {
    const item = bubbles[index];
    if (item?.role !== "plan") continue;
    const next = [...bubbles];
    next[index] = { role: "plan", plan: { ...item.plan, todos } };
    return next;
  }
  return [...bubbles, { role: "plan", plan: { plan: "", todos } }];
}

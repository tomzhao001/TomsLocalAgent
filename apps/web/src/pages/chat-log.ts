import type { LogEvent, PlanDocument, PlanTodo } from "@/lib/api";

export type ChatBubble =
  | { role: "user" | "assistant" | "error"; text: string }
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
  if (event.type === "text" && event.text) return [...bubbles, { role: "assistant", text: event.text }];
  if (event.type === "error") return [...bubbles, { role: "error", text: event.message }];
  if (event.type === "plan") return [...bubbles, { role: "plan", plan: event.plan }];
  if (event.type === "todos") return applyTodos(bubbles, event.todos);
  return bubbles;
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

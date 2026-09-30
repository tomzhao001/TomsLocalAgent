import type { DatabaseSync } from "node:sqlite";
import type { GatewayEvent, PlanDocument, PlanPhase, PlanTodo, PlanTodoStatus } from "@gateway/shared";

const statuses = new Set<PlanTodoStatus>(["pending", "in_progress", "completed", "cancelled"]);

export function planFromCreate(params: unknown): PlanDocument | null {
  if (!params || typeof params !== "object") return null;
  const raw = params as Record<string, unknown>;
  if (typeof raw.plan !== "string" || !raw.plan.trim()) return null;
  const phases = normalizePhases(raw.phases);
  return {
    ...(typeof raw.name === "string" && raw.name.trim() ? { name: raw.name } : {}),
    ...(typeof raw.overview === "string" && raw.overview.trim() ? { overview: raw.overview } : {}),
    plan: raw.plan,
    todos: normalizeTodos(raw.todos),
    ...(phases.length ? { phases } : {}),
  };
}

export function todosFromUpdate(params: unknown): { todos: PlanTodo[]; merge: boolean } | null {
  if (!params || typeof params !== "object") return null;
  const raw = params as Record<string, unknown>;
  if (!Array.isArray(raw.todos)) return null;
  return { todos: normalizeTodos(raw.todos), merge: raw.merge === true };
}

export function mergeTodos(current: PlanTodo[], incoming: PlanTodo[], merge: boolean): PlanTodo[] {
  if (!merge) return incoming;
  const next = [...current];
  for (const item of incoming) {
    const index = next.findIndex((todo) => todo.id === item.id);
    if (index >= 0) next[index] = item;
    else next.push(item);
  }
  return next;
}

export function applyPlanEvent(current: PlanDocument | null, event: GatewayEvent): PlanDocument | null {
  if (event.type === "plan") return event.plan;
  if (event.type === "todos") return { ...(current ?? { plan: "", todos: [] }), todos: event.todos };
  return current;
}

export function recordPlan(db: DatabaseSync, runId: string, event: GatewayEvent): void {
  if (event.type !== "plan" && event.type !== "todos") return;
  const row = db.prepare("SELECT plan_json FROM runs WHERE id = ?").get(runId) as { plan_json: string | null } | undefined;
  const current = parsePlan(row?.plan_json);
  const next = applyPlanEvent(current, event);
  if (!next) return;
  db.prepare("UPDATE runs SET plan_json = ? WHERE id = ?").run(JSON.stringify(next), runId);
}

export function latestPlanMarkdown(db: DatabaseSync, sessionId: string): string {
  const rows = db
    .prepare("SELECT plan_json FROM runs WHERE session_id = ? AND plan_json IS NOT NULL ORDER BY created_at DESC")
    .all(sessionId) as { plan_json: string }[];
  for (const row of rows) {
    const plan = parsePlan(row.plan_json);
    if (plan?.plan.trim()) return plan.plan.trim();
  }
  return "";
}

export function questionText(params: unknown): string {
  const questions = params && typeof params === "object" ? (params as { questions?: unknown }).questions : undefined;
  const lines = Array.isArray(questions)
    ? questions.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const prompt = (item as { prompt?: unknown }).prompt;
        return typeof prompt === "string" && prompt.trim() ? [prompt.trim()] : [];
      })
    : [];
  const body = lines.length ? lines.map((line) => `- ${line}`).join("\n") : "需要你补充信息。";
  return `需要你补充：\n${body}\n请在下一条消息里回答。`;
}

function parsePlan(json: string | null | undefined): PlanDocument | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as PlanDocument;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.todos)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function normalizeTodos(value: unknown): PlanTodo[] {
  if (!Array.isArray(value)) return [];
  const todos: PlanTodo[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const content = typeof raw.content === "string" ? raw.content.trim() : "";
    if (!content) continue;
    const status = statuses.has(raw.status as PlanTodoStatus) ? (raw.status as PlanTodoStatus) : "pending";
    todos.push({ id: typeof raw.id === "string" && raw.id ? raw.id : `todo-${todos.length + 1}`, content, status });
  }
  return todos;
}

function normalizePhases(value: unknown): PlanPhase[] {
  if (!Array.isArray(value)) return [];
  const phases: PlanPhase[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!name) continue;
    phases.push({ name, todos: normalizeTodos(raw.todos) });
  }
  return phases;
}

export type RunStatus = "running" | "finished" | "error" | "cancelled";

export type TokenUsage = {
  totalTokens: number;
  inputTokens?: number;
  outputTokens?: number;
};

export type PlanTodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export type PlanTodo = {
  id: string;
  content: string;
  status: PlanTodoStatus;
};

export type PlanPhase = {
  name: string;
  todos: PlanTodo[];
};

export type PlanDocument = {
  name?: string;
  overview?: string;
  plan: string;
  todos: PlanTodo[];
  phases?: PlanPhase[];
};

export type GatewayEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool-start" | "tool-end"; callId: string; name: string; detail?: string }
  | { type: "plan"; plan: PlanDocument }
  | { type: "todos"; todos: PlanTodo[] }
  | { type: "usage"; usage: TokenUsage }
  | { type: "done"; status: Exclude<RunStatus, "running"> }
  | { type: "error"; message: string };

export type ProviderId = "cursor" | "opencode";

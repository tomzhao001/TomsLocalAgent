export type Workspace = {
  id: string;
  name: string;
  path: string;
  repos: string[];
  archived: boolean;
  chatModel?: string;
  developModel?: string;
  reviewModel?: string;
};

export type FlowStatus = "waiting_input" | "running" | "idle";

export type GitBranchRef = { name: string; remote: boolean };

export type GitRepo = {
  path: string;
  name: string;
  branch: string;
  detached: boolean;
  dirty: boolean;
  branches: GitBranchRef[];
  error?: string;
};

export type GitChange = { path: string; code: string; added: number | null; deleted: number | null };

export type WorkspaceStatus = {
  workspaceId: string;
  status: FlowStatus;
  pending: number;
  drafts: number;
  splitting: number;
};

export type WorkflowId = "cursor-dev-loop" | "cursor-qa";

export type StepId = "plan" | "develop" | "review" | "devops" | "qa";

export type InputAction = "answer" | "continue" | "forcePass" | "abort";

export type RequirementCard = {
  title: string;
  goal: string;
  context: string;
  acceptanceCriteria: string[];
  relevantPaths?: string[];
  dependsOn?: number[];
};

export type ChoiceQuestion = {
  id: string;
  prompt: string;
  options: { id: string; label: string }[];
  allowMultiple?: boolean;
};

export type StepResult =
  | { verdict: "pass" | "reject"; comments: string }
  | { verdict: "need_input"; question: string; questions?: ChoiceQuestion[] };

export type StepRun = {
  id: string;
  step: StepId;
  attempt: number;
  status: "running" | "finished" | "error" | "cancelled" | "interrupted";
  result: StepResult | null;
  note: string | null;
  startedAt: number;
  endedAt: number | null;
};

export type WaitInfo = {
  kind: "question" | "limit" | "pushFailed" | "techError" | "qaFailed";
  fromStep: StepId;
  message: string;
  comments?: string;
  options: InputAction[];
  questions?: ChoiceQuestion[];
};

export type Requirement = {
  id: string;
  workspaceId: string;
  featureId: string | null;
  seq: number;
  card: RequirementCard;
  workflowId: WorkflowId;
  status: "pending" | "running" | "waiting_input" | "delivered" | "aborted";
  phase: StepId | "waiting" | "done" | "aborted" | null;
  reviewRejects: number;
  wait: WaitInfo | null;
  createdAt: number;
  finishedAt: number | null;
  steps: StepRun[];
};

export type Feature = { id: string; title: string; sharedContext: string; total: number; delivered: number };

export type SplitTask = {
  id: string;
  chatSessionId: string | null;
  prompt: string;
  status: "running" | "draft" | "confirmed" | "failed" | "discarded";
  draft: { sharedContext: string; cards: RequirementCard[] } | null;
  error: string | null;
  createdAt: number;
};

export type PlanTodo = {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
};

export type PlanDocument = {
  name?: string;
  overview?: string;
  plan: string;
  todos: PlanTodo[];
  phases?: { name: string; todos: PlanTodo[] }[];
};

export type LogEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool-start" | "tool-end"; callId: string; name: string; detail?: string }
  | { type: "plan"; plan: PlanDocument }
  | { type: "todos"; todos: PlanTodo[] }
  | { type: "usage"; usage: { totalTokens: number } }
  | { type: "done"; status: string }
  | { type: "error"; message: string };

export const readonlyViolation = "只读运行检测到文件改动";

export const workflowSteps: Record<WorkflowId, StepId[]> = {
  "cursor-dev-loop": ["plan", "develop", "review", "devops"],
  "cursor-qa": ["qa"],
};

export const workflowLabels: Record<WorkflowId, string> = {
  "cursor-dev-loop": "开发循环",
  "cursor-qa": "QA",
};

export const stepIds: StepId[] = workflowSteps["cursor-dev-loop"];

export const stepLabels: Record<StepId, string> = {
  plan: "Plan",
  develop: "开发",
  review: "Review",
  devops: "DevOps",
  qa: "QA",
};

export const rejectLimits = { review: 3 };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    credentials: "include",
    headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as T & { message?: string; error?: string };
  if (!res.ok) throw new ApiError(body.message ?? "请求失败", body.error ?? "request_failed", res.status);
  return body;
}

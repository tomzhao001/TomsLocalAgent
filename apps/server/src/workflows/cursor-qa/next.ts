import type { ChoiceQuestion, InputAction, WaitKind } from "../cursor-dev-loop/next.js";

export type QaState = {
  phase: "qa" | "waiting" | "done" | "aborted";
  techErrors: number;
  waitingFrom?: "qa";
};

export type QaEvent =
  | { type: "start" }
  | { type: "qa"; pass: boolean }
  | { type: "techError" }
  | { type: "needInput"; question: string; questions?: ChoiceQuestion[] }
  | { type: "answer"; text: string }
  | { type: "abort" };

export type QaAction =
  | { kind: "runStep"; nodeId: "qa"; cardIndex: number; prompt: string }
  | { kind: "waitInput"; reason: string; waitKind: WaitKind; fromStep: "qa"; options: InputAction[]; questions?: ChoiceQuestion[] }
  | { kind: "cardDelivered"; cardIndex: number }
  | { kind: "aborted" };

const retryOptions: InputAction[] = ["answer", "abort"];

export function initialQaState(): QaState {
  return { phase: "qa", techErrors: 0 };
}

export function normalizeQaState(raw: unknown): QaState {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const phase = input.phase === "waiting" || input.phase === "done" || input.phase === "aborted" ? input.phase : "qa";
  const state: QaState = {
    phase,
    techErrors: typeof input.techErrors === "number" ? input.techErrors : 0,
  };
  if (phase === "waiting") state.waitingFrom = "qa";
  return state;
}

export function nextQa(state: QaState, event: QaEvent): { state: QaState; action: QaAction } {
  if (event.type === "abort") return { state: { ...state, phase: "aborted" }, action: { kind: "aborted" } };
  if (state.phase === "done" || state.phase === "aborted") {
    return { state, action: state.phase === "done" ? { kind: "cardDelivered", cardIndex: 0 } : { kind: "aborted" } };
  }
  if (event.type === "start") return run(state, "开始 QA");
  if (event.type === "techError") return onTechError(state);
  if (state.phase === "waiting") return onWait(state, event);
  if (event.type === "needInput") return wait(state, event.question, "question", event.questions);
  if (state.phase === "qa" && event.type === "qa") {
    if (event.pass) {
      return { state: { ...state, phase: "done", waitingFrom: undefined, techErrors: 0 }, action: { kind: "cardDelivered", cardIndex: 0 } };
    }
    return wait(state, "E2E 未通过", "qaFailed");
  }
  return run(state, "保持 QA");
}

export function toQaEvent(
  result: { verdict: "pass" | "reject"; comments: string } | { verdict: "need_input"; question: string; questions?: ChoiceQuestion[] } | null,
): QaEvent {
  if (!result) return { type: "techError" };
  if (result.verdict === "need_input") {
    return { type: "needInput", question: result.question, ...(result.questions?.length ? { questions: result.questions } : {}) };
  }
  if (result.verdict === "reject" && !result.comments.trim()) return { type: "techError" };
  return { type: "qa", pass: result.verdict === "pass" };
}

function onTechError(state: QaState): { state: QaState; action: QaAction } {
  const techErrors = state.techErrors + 1;
  if (techErrors >= 2) return wait({ ...state, techErrors }, "同一步连续技术错误", "techError");
  return run({ ...state, techErrors }, "技术错误后重试");
}

function onWait(state: QaState, event: QaEvent): { state: QaState; action: QaAction } {
  if (event.type === "answer") return run({ ...state, waitingFrom: undefined }, `用户回复：${event.text}`);
  return { state, action: { kind: "waitInput", reason: "仍在等待输入", waitKind: "qaFailed", fromStep: "qa", options: retryOptions } };
}

function run(state: QaState, prompt: string): { state: QaState; action: QaAction } {
  return {
    state: { ...state, phase: "qa", waitingFrom: undefined },
    action: { kind: "runStep", nodeId: "qa", cardIndex: 0, prompt },
  };
}

function wait(state: QaState, reason: string, waitKind: WaitKind, questions?: ChoiceQuestion[]): { state: QaState; action: QaAction } {
  return {
    state: { ...state, phase: "waiting", waitingFrom: "qa", techErrors: 0 },
    action: {
      kind: "waitInput",
      reason,
      waitKind,
      fromStep: "qa",
      options: retryOptions,
      ...(questions?.length ? { questions } : {}),
    },
  };
}

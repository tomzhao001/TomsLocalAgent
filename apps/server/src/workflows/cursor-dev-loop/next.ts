export type LoopConfig = {
  reviewRejectLimit: number;
};

export const defaultLoopConfig: LoopConfig = { reviewRejectLimit: 3 };

export type StepId = "plan" | "develop" | "review" | "devops";

export const stepIds: StepId[] = ["plan", "develop", "review", "devops"];

export type DevLoopState = {
  cardCount: number;
  index: number;
  phase: StepId | "waiting" | "done" | "aborted";
  reviewRejects: number;
  techErrors: number;
  waitingFrom?: StepId;
};

export type LoopEvent =
  | { type: "start" }
  | { type: "stepOk" }
  | { type: "review"; pass: boolean }
  | { type: "devops"; results: boolean[] }
  | { type: "techError" }
  | { type: "needInput"; question: string; questions?: ChoiceQuestion[] }
  | { type: "answer"; text: string }
  | { type: "continue"; text: string }
  | { type: "forcePass" }
  | { type: "abort" };

export type WaitKind = "question" | "limit" | "pushFailed" | "techError" | "qaFailed";

export type InputAction = "answer" | "continue" | "forcePass" | "abort";

export type ChoiceQuestion = {
  id: string;
  prompt: string;
  options: { id: string; label: string }[];
  allowMultiple?: boolean;
};

export type LoopAction =
  | { kind: "runStep"; nodeId: StepId; cardIndex: number; prompt: string }
  | { kind: "waitInput"; reason: string; waitKind: WaitKind; fromStep: StepId; options: InputAction[]; questions?: ChoiceQuestion[] }
  | { kind: "cardDelivered"; cardIndex: number }
  | { kind: "done" }
  | { kind: "aborted" };

const waitOptions: Record<WaitKind, InputAction[]> = {
  question: ["answer", "abort"],
  limit: ["continue", "forcePass", "abort"],
  pushFailed: ["answer", "forcePass", "abort"],
  techError: ["answer", "abort"],
  qaFailed: ["answer", "abort"],
};

const phases = new Set<DevLoopState["phase"]>(["plan", "develop", "review", "devops", "waiting", "done", "aborted"]);

export function normalizeStepId(step: string): StepId {
  if (step === "plan") return "plan";
  if (step === "arch" || step === "review") return "review";
  if (step === "qa" || step === "devops") return "devops";
  return "develop";
}

export function normalizeLoopState(raw: unknown): DevLoopState {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const phase = normalizePhase(typeof input.phase === "string" ? input.phase : "develop");
  const state: DevLoopState = {
    cardCount: typeof input.cardCount === "number" ? input.cardCount : 1,
    index: typeof input.index === "number" ? input.index : 0,
    phase,
    reviewRejects:
      typeof input.reviewRejects === "number"
        ? input.reviewRejects
        : typeof input.archRejects === "number"
          ? input.archRejects
          : 0,
    techErrors: typeof input.techErrors === "number" ? input.techErrors : 0,
  };
  if (typeof input.waitingFrom === "string") {
    state.waitingFrom = input.waitingFrom === "qa" ? "review" : normalizeStepId(input.waitingFrom);
  }
  return state;
}

export function initialLoopState(cardCount: number): DevLoopState {
  return { cardCount, index: 0, phase: "plan", reviewRejects: 0, techErrors: 0 };
}

export function nextLoop(state: DevLoopState, event: LoopEvent, cfg: LoopConfig = defaultLoopConfig): { state: DevLoopState; action: LoopAction } {
  if (event.type === "abort") return { state: { ...state, phase: "aborted" }, action: { kind: "aborted" } };
  if (state.phase === "done" || state.phase === "aborted") return { state, action: { kind: state.phase === "done" ? "done" : "aborted" } };
  if (event.type === "start") return run(state, "plan", "先写计划");
  if (event.type === "techError") return onTechError(state);
  if (state.phase === "waiting") return onWait(state, event);
  if (event.type === "needInput") return wait(clearTech(state), state.phase, event.question, "question", event.questions);
  if (state.phase === "plan" && event.type === "stepOk") return run(clearTech(state, "develop"), "develop", "按计划开发");
  if (state.phase === "develop" && event.type === "stepOk") return run(clearTech(state, "review"), "review", "Review");
  if (state.phase === "review" && event.type === "review") return onReview(state, event.pass, cfg);
  if (state.phase === "devops" && event.type === "devops") return onDevops(state, event.results);
  return { state, action: runAction(state, state.phase, "保持当前步骤") };
}

function onReview(state: DevLoopState, pass: boolean, cfg: LoopConfig): { state: DevLoopState; action: LoopAction } {
  if (pass) return run(clearTech({ ...state, phase: "devops" }), "devops", "DevOps 发布");
  const reviewRejects = state.reviewRejects + 1;
  const next = clearTech({ ...state, reviewRejects });
  if (reviewRejects <= cfg.reviewRejectLimit) return run(next, "plan", "Review 打回，先改计划");
  return wait(next, "review", "Review 超过打回上限", "limit");
}

function onDevops(state: DevLoopState, results: boolean[]): { state: DevLoopState; action: LoopAction } {
  if (results.some((ok) => !ok)) return wait(clearTech(state), "devops", "有仓库推送失败", "pushFailed");
  const deliveredIndex = state.index;
  if (state.index + 1 >= state.cardCount) {
    return {
      state: { ...clearTech(state), phase: "done" },
      action: { kind: "cardDelivered", cardIndex: deliveredIndex },
    };
  }
  const advanced = clearTech({
    ...state,
    index: state.index + 1,
    phase: "plan",
    reviewRejects: 0,
  });
  return {
    state: advanced,
    action: { kind: "runStep", nodeId: "plan", cardIndex: advanced.index, prompt: `交付第 ${deliveredIndex + 1} 张后为下一张写计划` },
  };
}

function onTechError(state: DevLoopState): { state: DevLoopState; action: LoopAction } {
  const techErrors = state.techErrors + 1;
  const current = state.phase === "waiting" ? state.waitingFrom ?? "develop" : state.phase;
  const phase: StepId = current === "plan" || current === "review" || current === "devops" ? current : "develop";
  if (techErrors >= 2) return wait({ ...state, techErrors, waitingFrom: phase }, phase, "同一步连续技术错误", "techError");
  return run({ ...state, techErrors }, phase, "技术错误后重试");
}

function onWait(state: DevLoopState, event: LoopEvent): { state: DevLoopState; action: LoopAction } {
  if (event.type === "answer") {
    const from = state.waitingFrom ?? "develop";
    return run({ ...state, phase: from, waitingFrom: undefined }, from, `用户回复：${event.text}`);
  }
  if (event.type === "continue") return run({ ...state, phase: "plan", waitingFrom: undefined }, "plan", `人工继续：${event.text}`);
  if (event.type === "forcePass") {
    if (state.waitingFrom === "review") return run({ ...state, phase: "devops", waitingFrom: undefined }, "devops", "强制通过 Review");
    return onDevops({ ...state, phase: "devops", waitingFrom: undefined }, []);
  }
  const from = state.waitingFrom ?? "develop";
  return { state, action: { kind: "waitInput", reason: "仍在等待输入", waitKind: "limit", fromStep: from, options: waitOptions.limit } };
}

function run(state: DevLoopState, nodeId: StepId, prompt: string): { state: DevLoopState; action: LoopAction } {
  return { state: { ...state, phase: nodeId, waitingFrom: undefined }, action: runAction(state, nodeId, prompt) };
}

function runAction(state: DevLoopState, nodeId: StepId, prompt: string): LoopAction {
  return { kind: "runStep", nodeId, cardIndex: state.index, prompt };
}

function wait(
  state: DevLoopState,
  from: StepId,
  reason: string,
  waitKind: WaitKind,
  questions?: ChoiceQuestion[],
): { state: DevLoopState; action: LoopAction } {
  return {
    state: { ...state, phase: "waiting", waitingFrom: from, techErrors: 0 },
    action: {
      kind: "waitInput",
      reason,
      waitKind,
      fromStep: from,
      options: waitOptions[waitKind],
      ...(questions?.length ? { questions } : {}),
    },
  };
}

function clearTech(state: DevLoopState, phase?: StepId): DevLoopState {
  return { ...state, techErrors: 0, phase: phase ?? state.phase };
}

function normalizePhase(phase: string): DevLoopState["phase"] {
  if (phase === "arch") return "review";
  if (phase === "qa") return "devops";
  if (phases.has(phase as DevLoopState["phase"])) return phase as DevLoopState["phase"];
  return "develop";
}

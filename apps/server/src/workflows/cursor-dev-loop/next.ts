export type LoopConfig = {
  archRejectLimit: number;
  qaRejectLimit: number;
};

export const defaultLoopConfig: LoopConfig = { archRejectLimit: 3, qaRejectLimit: 2 };

export type StepId = "develop" | "arch" | "qa" | "devops";

export type DevLoopState = {
  cardCount: number;
  index: number;
  phase: StepId | "waiting" | "done" | "aborted";
  archRejects: number;
  qaRejects: number;
  techErrors: number;
  waitingFrom?: StepId;
};

export type LoopEvent =
  | { type: "start" }
  | { type: "stepOk" }
  | { type: "review"; pass: boolean }
  | { type: "qa"; pass: boolean }
  | { type: "devops"; results: boolean[] }
  | { type: "techError" }
  | { type: "continue"; text: string }
  | { type: "forcePass" }
  | { type: "abort" };

export type LoopAction =
  | { kind: "runStep"; nodeId: StepId; cardIndex: number; prompt: string }
  | { kind: "waitInput"; reason: string; options: string[] }
  | { kind: "cardDelivered"; cardIndex: number }
  | { kind: "done" }
  | { kind: "aborted" };

const options = ["继续修改", "强制通过", "终止"];

export function initialLoopState(cardCount: number): DevLoopState {
  return { cardCount, index: 0, phase: "develop", archRejects: 0, qaRejects: 0, techErrors: 0 };
}

export function nextLoop(state: DevLoopState, event: LoopEvent, cfg: LoopConfig = defaultLoopConfig): { state: DevLoopState; action: LoopAction } {
  if (event.type === "abort") return { state: { ...state, phase: "aborted" }, action: { kind: "aborted" } };
  if (state.phase === "done" || state.phase === "aborted") return { state, action: { kind: state.phase === "done" ? "done" : "aborted" } };
  if (event.type === "start") return run(state, "develop", "开始开发");
  if (event.type === "techError") return onTechError(state);
  if (state.phase === "waiting") return onWait(state, event);
  if (state.phase === "develop" && event.type === "stepOk") return run(clearTech(state, "arch"), "arch", "架构审核");
  if (state.phase === "arch" && event.type === "review") return onArch(state, event.pass, cfg);
  if (state.phase === "qa" && event.type === "qa") return onQa(state, event.pass, cfg);
  if (state.phase === "devops" && event.type === "devops") return onDevops(state, event.results);
  return { state, action: runAction(state, state.phase as StepId, "保持当前步骤") };
}

function onArch(state: DevLoopState, pass: boolean, cfg: LoopConfig): { state: DevLoopState; action: LoopAction } {
  if (pass) return run(clearTech({ ...state, phase: "qa" }), "qa", "QA");
  const archRejects = state.archRejects + 1;
  const next = clearTech({ ...state, archRejects });
  if (archRejects <= cfg.archRejectLimit) return run(next, "develop", "架构打回，继续开发");
  return wait(next, "arch", "架构审核超过打回上限");
}

function onQa(state: DevLoopState, pass: boolean, cfg: LoopConfig): { state: DevLoopState; action: LoopAction } {
  if (pass) return run(clearTech({ ...state, phase: "devops" }), "devops", "DevOps 发布");
  const qaRejects = state.qaRejects + 1;
  const next = clearTech({ ...state, qaRejects });
  if (qaRejects <= cfg.qaRejectLimit) return run(next, "develop", "QA 打回，继续开发");
  return wait(next, "qa", "QA 超过打回上限");
}

function onDevops(state: DevLoopState, results: boolean[]): { state: DevLoopState; action: LoopAction } {
  if (results.some((ok) => !ok)) return wait(clearTech(state), "devops", "有仓库推送失败");
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
    phase: "develop",
    archRejects: 0,
    qaRejects: 0,
  });
  return {
    state: advanced,
    action: { kind: "runStep", nodeId: "develop", cardIndex: advanced.index, prompt: `交付第 ${deliveredIndex + 1} 张后开发下一张` },
  };
}

function onTechError(state: DevLoopState): { state: DevLoopState; action: LoopAction } {
  const techErrors = state.techErrors + 1;
  const phase = state.phase === "waiting" ? state.waitingFrom ?? "develop" : state.phase;
  if (techErrors >= 2) return wait({ ...state, techErrors, waitingFrom: phase as StepId }, phase as StepId, "同一步连续技术错误");
  return run({ ...state, techErrors }, phase as StepId, "技术错误后重试");
}

function onWait(state: DevLoopState, event: LoopEvent): { state: DevLoopState; action: LoopAction } {
  if (event.type === "continue") return run({ ...state, phase: "develop", waitingFrom: undefined }, "develop", `人工继续：${event.text}`);
  if (event.type === "forcePass") {
    if (state.waitingFrom === "arch") return run({ ...state, phase: "qa", waitingFrom: undefined }, "qa", "强制通过架构审核");
    if (state.waitingFrom === "qa") return run({ ...state, phase: "devops", waitingFrom: undefined }, "devops", "强制通过 QA");
    return onDevops({ ...state, phase: "devops", waitingFrom: undefined }, []);
  }
  return { state, action: { kind: "waitInput", reason: "仍在等待输入", options } };
}

function run(state: DevLoopState, nodeId: StepId, prompt: string): { state: DevLoopState; action: LoopAction } {
  return { state: { ...state, phase: nodeId, waitingFrom: undefined }, action: runAction(state, nodeId, prompt) };
}

function runAction(state: DevLoopState, nodeId: StepId, prompt: string): LoopAction {
  return { kind: "runStep", nodeId, cardIndex: state.index, prompt };
}

function wait(state: DevLoopState, from: StepId, reason: string): { state: DevLoopState; action: LoopAction } {
  return {
    state: { ...state, phase: "waiting", waitingFrom: from, techErrors: 0 },
    action: { kind: "waitInput", reason, options },
  };
}

function clearTech(state: DevLoopState, phase?: StepId): DevLoopState {
  return { ...state, techErrors: 0, phase: phase ?? state.phase };
}

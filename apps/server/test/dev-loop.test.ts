import { describe, expect, it } from "vitest";
import { defaultLoopConfig, initialLoopState, nextLoop, normalizeLoopState, type DevLoopState, type LoopConfig, type LoopEvent } from "../src/workflows/cursor-dev-loop/next.js";

const cfg = defaultLoopConfig;

function drive(events: LoopEvent[], config: LoopConfig = cfg, cards = 1): DevLoopState {
  let state = initialLoopState(cards);
  for (const event of events) state = nextLoop(state, event, config).state;
  return state;
}

describe("cursor-dev-loop", () => {
  it("五张卡严格按序，前一张交付后才进入下一张", () => {
    let state = initialLoopState(5);
    for (let card = 0; card < 5; card++) {
      const started = nextLoop(state, card === 0 ? { type: "start" } : { type: "stepOk" }, cfg);
      expect(started.action).toMatchObject({ kind: "runStep", nodeId: card === 0 ? "develop" : "review", cardIndex: card });
      state = passRest(card === 0 ? started.state : state, card);
      expect(state.index).toBe(Math.min(card + 1, 4));
    }
    expect(state.phase).toBe("done");
  });

  it.each([
    [1, "develop"],
    [2, "develop"],
    [3, "develop"],
    [4, "waiting"],
  ] as const)("Review 第 %i 次不通过后阶段是 %s", (fails, phase) => {
    let state = nextLoop(initialLoopState(1), { type: "start" }, cfg).state;
    state = nextLoop(state, { type: "stepOk" }, cfg).state;
    for (let i = 0; i < fails; i++) {
      const result = nextLoop(state, { type: "review", pass: false }, cfg);
      state = result.state;
      if (i < fails - 1) state = nextLoop(state, { type: "stepOk" }, cfg).state;
    }
    expect(state.phase).toBe(phase);
    expect(state.reviewRejects).toBe(fails);
  });

  it("手动放行后再次不通过仍然暂停", () => {
    let state = drive([{ type: "start" }, { type: "stepOk" }]);
    for (let i = 0; i < 3; i++) {
      state = nextLoop(state, { type: "review", pass: false }, cfg).state;
      state = nextLoop(state, { type: "stepOk" }, cfg).state;
    }
    const paused = nextLoop(state, { type: "review", pass: false }, cfg);
    expect(paused.action.kind).toBe("waitInput");
    const again = nextLoop(nextLoop(paused.state, { type: "continue", text: "再改" }, cfg).state, { type: "stepOk" }, cfg);
    const second = nextLoop(again.state, { type: "review", pass: false }, cfg);
    expect(second.action.kind).toBe("waitInput");
    expect(second.state.reviewRejects).toBe(5);
  });

  it("上限用配置，超过上限后的暂停不能被额外开关关掉", () => {
    const custom = { reviewRejectLimit: 1 };
    let state = nextLoop(initialLoopState(1), { type: "start" }, custom).state;
    state = nextLoop(state, { type: "stepOk" }, custom).state;
    state = nextLoop(state, { type: "review", pass: false }, custom).state;
    const paused = nextLoop(state, { type: "stepOk" }, custom);
    const again = nextLoop(paused.state, { type: "review", pass: false }, { ...custom, reviewRejectLimit: 1 });
    expect(again.action.kind).toBe("waitInput");
  });

  it("多仓库里有一个失败就暂停，全部成功才进入下一张", () => {
    const failed = nextLoop(reachDevops(initialLoopState(2)), { type: "devops", results: [true, false] }, cfg);
    expect(failed.action.kind).toBe("waitInput");
    expect(failed.state.index).toBe(0);
    const ok = nextLoop(reachDevops(initialLoopState(2)), { type: "devops", results: [true, true] }, cfg);
    expect(ok.action).toMatchObject({ kind: "runStep", cardIndex: 1 });
  });

  it("技术错误不计入打回，连续两次才暂停", () => {
    let state = nextLoop(initialLoopState(1), { type: "start" }, cfg).state;
    const once = nextLoop(state, { type: "techError" }, cfg);
    expect(once.action).toMatchObject({ nodeId: "develop" });
    expect(once.state.reviewRejects).toBe(0);
    const twice = nextLoop(once.state, { type: "techError" }, cfg);
    expect(twice.action.kind).toBe("waitInput");
  });

  it("人工继续、强制通过和终止", () => {
    let state = nextLoop(initialLoopState(1), { type: "start" }, cfg).state;
    state = nextLoop(state, { type: "stepOk" }, cfg).state;
    for (let i = 0; i < 4; i++) {
      const step = nextLoop(state, { type: "review", pass: false }, cfg);
      state = step.state;
      if (step.action.kind === "runStep") state = nextLoop(state, { type: "stepOk" }, cfg).state;
    }
    const continued = nextLoop(state, { type: "continue", text: "看这里" }, cfg);
    expect(continued.action).toMatchObject({ nodeId: "develop", prompt: expect.stringContaining("看这里") });
    const forced = nextLoop(state, { type: "forcePass" }, cfg);
    expect(forced.action).toMatchObject({ nodeId: "devops" });
    const aborted = nextLoop(state, { type: "abort" }, cfg);
    expect(aborted.action.kind).toBe("aborted");
  });

  it("任何步骤提问都会暂停，回答后回到提问的那一步", () => {
    const developing = nextLoop(initialLoopState(1), { type: "start" }, cfg).state;
    const asked = nextLoop(developing, { type: "needInput", question: "用 SQLite 还是 JSON？" }, cfg);
    expect(asked.action).toMatchObject({
      kind: "waitInput",
      waitKind: "question",
      fromStep: "develop",
      reason: "用 SQLite 还是 JSON？",
      options: ["answer", "abort"],
    });
    const answered = nextLoop(asked.state, { type: "answer", text: "SQLite" }, cfg);
    expect(answered.action).toMatchObject({ kind: "runStep", nodeId: "develop", prompt: expect.stringContaining("SQLite") });

    const reviewing = reachReview(initialLoopState(1));
    const reviewAsked = nextLoop(reviewing, { type: "needInput", question: "这条验收标准指哪段？" }, cfg);
    expect(reviewAsked.state.waitingFrom).toBe("review");
    const reviewAnswered = nextLoop(reviewAsked.state, { type: "answer", text: "登录按钮" }, cfg);
    expect(reviewAnswered.action).toMatchObject({ kind: "runStep", nodeId: "review" });
    expect(reviewAnswered.state.reviewRejects).toBe(0);
  });

  it("超限暂停可以继续修改或强制通过，推送失败可以重试 DevOps", () => {
    let state = reachReview(initialLoopState(1));
    for (let i = 0; i < 4; i++) {
      state = nextLoop(state, { type: "review", pass: false }, cfg).state;
      if (state.phase === "develop") {
        state = nextLoop(state, { type: "stepOk" }, cfg).state;
      }
    }
    expect(state.phase).toBe("waiting");
    const pushFailed = nextLoop(reachDevops(initialLoopState(1)), { type: "devops", results: [false] }, cfg);
    expect(pushFailed.action).toMatchObject({ kind: "waitInput", waitKind: "pushFailed", fromStep: "devops" });
    const retried = nextLoop(pushFailed.state, { type: "answer", text: "网络好了" }, cfg);
    expect(retried.action).toMatchObject({ kind: "runStep", nodeId: "devops" });
    const forced = nextLoop(pushFailed.state, { type: "forcePass" }, cfg);
    expect(forced.state.phase).toBe("done");
  });

  it("旧的架构审核和 QA 状态能接着跑", () => {
    const review = normalizeLoopState({ phase: "arch", archRejects: 2, cardCount: 3, index: 1, techErrors: 0 });
    expect(review).toMatchObject({ phase: "review", reviewRejects: 2, cardCount: 3, index: 1 });
    const devops = normalizeLoopState({ phase: "qa", waitingFrom: "qa", archRejects: 1 });
    expect(devops.phase).toBe("devops");
    expect(devops.waitingFrom).toBe("review");
    expect(devops.reviewRejects).toBe(1);
    const passed = nextLoop({ ...devops, phase: "devops", waitingFrom: undefined }, { type: "devops", results: [true] }, cfg);
    expect(passed.state.phase).toBe("done");
  });
});

function passRest(state: DevLoopState, _card: number): DevLoopState {
  let current = state.phase === "develop" ? nextLoop(state, { type: "stepOk" }, cfg).state : state;
  current = nextLoop(current, { type: "review", pass: true }, cfg).state;
  return nextLoop(current, { type: "devops", results: [true] }, cfg).state;
}

function reachReview(state: DevLoopState): DevLoopState {
  let current = nextLoop(state, { type: "start" }, cfg).state;
  return nextLoop(current, { type: "stepOk" }, cfg).state;
}

function reachDevops(state: DevLoopState): DevLoopState {
  return nextLoop(reachReview(state), { type: "review", pass: true }, cfg).state;
}

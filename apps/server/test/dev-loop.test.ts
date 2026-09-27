import { describe, expect, it } from "vitest";
import { defaultLoopConfig, initialLoopState, nextLoop, type DevLoopState, type LoopConfig, type LoopEvent } from "../src/workflows/cursor-dev-loop/next.js";

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
      expect(started.action).toMatchObject({ kind: "runStep", nodeId: card === 0 ? "develop" : "arch", cardIndex: card });
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
  ] as const)("架构第 %i 次不通过后阶段是 %s", (fails, phase) => {
    let state = nextLoop(initialLoopState(1), { type: "start" }, cfg).state;
    state = nextLoop(state, { type: "stepOk" }, cfg).state;
    for (let i = 0; i < fails; i++) {
      const result = nextLoop(state, { type: "review", pass: false }, cfg);
      state = result.state;
      if (i < fails - 1) state = nextLoop(state, { type: "stepOk" }, cfg).state;
    }
    expect(state.phase).toBe(phase);
    expect(state.archRejects).toBe(fails);
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
    expect(second.state.archRejects).toBe(5);
  });

  it.each([
    [1, "develop"],
    [2, "develop"],
    [3, "waiting"],
  ] as const)("QA 第 %i 次不通过后阶段是 %s", (fails, phase) => {
    let state = reachQa(initialLoopState(1));
    for (let i = 0; i < fails; i++) {
      const result = nextLoop(state, { type: "qa", pass: false }, cfg);
      state = result.state;
      if (phase === "develop" && i === fails - 1) expect(result.action).toMatchObject({ nodeId: "develop" });
      if (i < fails - 1) {
        state = nextLoop(state, { type: "stepOk" }, cfg).state;
        state = nextLoop(state, { type: "review", pass: true }, cfg).state;
      }
    }
    expect(state.phase).toBe(phase);
  });

  it("QA 打回后的架构不通过计入架构次数", () => {
    let state = reachQa(initialLoopState(1));
    state = nextLoop(state, { type: "qa", pass: false }, cfg).state;
    state = nextLoop(state, { type: "stepOk" }, cfg).state;
    const review = nextLoop(state, { type: "review", pass: false }, cfg);
    expect(review.state.archRejects).toBe(1);
    expect(review.action).toMatchObject({ nodeId: "develop" });
  });

  it("上限用配置，超过上限后的暂停不能被额外开关关掉", () => {
    const custom = { archRejectLimit: 1, qaRejectLimit: 1 };
    let state = nextLoop(initialLoopState(1), { type: "start" }, custom).state;
    state = nextLoop(state, { type: "stepOk" }, custom).state;
    state = nextLoop(state, { type: "review", pass: false }, custom).state;
    const paused = nextLoop(state, { type: "stepOk" }, custom);
    const again = nextLoop(paused.state, { type: "review", pass: false }, { ...custom, archRejectLimit: 1 });
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
    expect(once.state.archRejects).toBe(0);
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
    expect(forced.action).toMatchObject({ nodeId: "qa" });
    const aborted = nextLoop(state, { type: "abort" }, cfg);
    expect(aborted.action.kind).toBe("aborted");
  });
});

function passRest(state: DevLoopState, _card: number): DevLoopState {
  let current = state.phase === "develop" ? nextLoop(state, { type: "stepOk" }, cfg).state : state;
  current = nextLoop(current, { type: "review", pass: true }, cfg).state;
  current = nextLoop(current, { type: "qa", pass: true }, cfg).state;
  return nextLoop(current, { type: "devops", results: [true] }, cfg).state;
}

function reachQa(state: DevLoopState): DevLoopState {
  let current = nextLoop(state, { type: "start" }, cfg).state;
  current = nextLoop(current, { type: "stepOk" }, cfg).state;
  return nextLoop(current, { type: "review", pass: true }, cfg).state;
}

function reachDevops(state: DevLoopState): DevLoopState {
  return nextLoop(reachQa(state), { type: "qa", pass: true }, cfg).state;
}

import {
  initialLoopState,
  nextLoop,
  type DevLoopState,
  type LoopAction,
  type LoopConfig,
  type LoopEvent,
} from "../cursor-dev-loop/next.js";

export type EngineStatus = "running" | "waiting_input" | "done" | "aborted";

export async function runLoop(options: {
  cardCount: number;
  cfg?: LoopConfig;
  execute: (action: Extract<LoopAction, { kind: "runStep" }>) => Promise<LoopEvent>;
  onState?: (state: DevLoopState, version: number) => void;
  resume?: DevLoopState;
}): Promise<{ state: DevLoopState; status: EngineStatus; version: number }> {
  if (options.resume?.phase === "waiting") {
    return { state: options.resume, status: "waiting_input", version: 0 };
  }
  let version = 1;
  let current = nextLoop(options.resume ?? initialLoopState(options.cardCount), { type: "start" }, options.cfg);
  options.onState?.(current.state, version);
  while (true) {
    if (current.action.kind === "waitInput") return { state: current.state, status: "waiting_input", version };
    if (current.action.kind === "aborted") return { state: current.state, status: "aborted", version };
    if (current.state.phase === "done") return { state: current.state, status: "done", version };
    if (current.action.kind !== "runStep") return { state: current.state, status: "done", version };
    const event = await options.execute(current.action);
    current = nextLoop(current.state, event, options.cfg);
    version += 1;
    options.onState?.(current.state, version);
  }
}

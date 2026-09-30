import { describe, expect, it } from "vitest";
import { LiveRun } from "../src/live-run.js";

describe("实时通道", () => {
  it("先通知订阅者，再写入归档", () => {
    const live = new LiveRun();
    const seen: string[] = [];
    live.subscribe(0, (frame) => seen.push(`push:${frame.event.type}`), () => seen.push("end"));
    live.publish({ type: "text", text: "甲" }, () => seen.push("file"));
    expect(seen).toEqual(["push:text", "file"]);
  });

  it("退订不会结束这次运行", () => {
    const live = new LiveRun();
    let ended = false;
    const stop = live.subscribe(0, () => {}, () => {
      ended = true;
    });
    stop();
    live.publish({ type: "text", text: "还在" }, () => {});
    expect(ended).toBe(false);
    expect(live.status).toBe("running");
    live.finish("finished");
    expect(ended).toBe(false);
    expect(live.status).toBe("finished");
  });

  it("后连上的订阅者只收到 after 之后的事件", () => {
    const live = new LiveRun();
    live.publish({ type: "text", text: "先" }, () => {});
    const seen: string[] = [];
    live.subscribe(1, (frame) => {
      if (frame.event.type === "text") seen.push(frame.event.text);
    }, () => {});
    live.publish({ type: "text", text: "后" }, () => {});
    expect(seen).toEqual(["后"]);
  });
});

import type { GatewayTool } from "../../runs.js";
import type { LoopEvent, StepId } from "../cursor-dev-loop/next.js";

export type StepResult =
  | { verdict: "pass" | "reject"; comments: string }
  | { verdict: "need_input"; question: string };

export function stepTools(record: (result: StepResult) => void): Record<string, GatewayTool> {
  return {
    submit_verdict: {
      description:
        "提交本步骤的结果。开发和 DevOps 完成后提交 pass；架构审核和 QA 按判定提交 pass 或 reject；DevOps 有仓库推送失败时提交 reject。comments 写明理由或改动摘要。",
      inputSchema: {
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["pass", "reject"] },
          comments: { type: "string" },
        },
        required: ["verdict", "comments"],
      },
      execute(args) {
        const verdict = args.verdict === "reject" ? "reject" : args.verdict === "pass" ? "pass" : null;
        if (!verdict) return { content: [{ type: "text", text: "verdict 只能是 pass 或 reject" }], isError: true };
        record({ verdict, comments: typeof args.comments === "string" ? args.comments : "" });
        return "已记录结果，请结束本轮回复。";
      },
    },
    ask_user: {
      description: "遇到必须由用户决定的问题时调用。调用后立即结束本轮回复，等待用户回答后会在同一个对话里继续。",
      inputSchema: {
        type: "object",
        properties: { question: { type: "string" } },
        required: ["question"],
      },
      execute(args) {
        const question = typeof args.question === "string" ? args.question.trim() : "";
        if (!question) return { content: [{ type: "text", text: "question 不能为空" }], isError: true };
        record({ verdict: "need_input", question });
        return "问题已提交，请结束本轮回复。";
      },
    },
  };
}

const blockPattern = /<gateway-result>([\s\S]*?)<\/gateway-result>/g;

export function parseResultBlock(texts: string[]): StepResult | null {
  const matches = [...texts.join("\n").matchAll(blockPattern)];
  const last = matches.at(-1)?.[1];
  if (!last) return null;
  try {
    const parsed = JSON.parse(last) as { verdict?: string; comments?: string; question?: string };
    if (parsed.verdict === "need_input" && parsed.question) return { verdict: "need_input", question: parsed.question };
    if (parsed.verdict === "pass" || parsed.verdict === "reject") {
      return { verdict: parsed.verdict, comments: parsed.comments ?? "" };
    }
  } catch {
    return null;
  }
  return null;
}

export function toLoopEvent(step: StepId, result: StepResult | null): LoopEvent {
  if (!result) return { type: "techError" };
  if (result.verdict === "need_input") return { type: "needInput", question: result.question };
  const pass = result.verdict === "pass";
  if (step === "arch") return { type: "review", pass };
  if (step === "qa") return { type: "qa", pass };
  if (step === "devops") return { type: "devops", results: [pass] };
  return { type: "stepOk" };
}

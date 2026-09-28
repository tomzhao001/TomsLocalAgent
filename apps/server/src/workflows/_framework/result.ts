import type { GatewayTool } from "../../runs.js";
import type { LoopEvent, StepId } from "../cursor-dev-loop/next.js";

export type StepResult =
  | { verdict: "pass" | "reject"; comments: string }
  | { verdict: "need_input"; question: string };

export function stepTools(record: (result: StepResult) => void): Record<string, GatewayTool> {
  return {
    submit_verdict: {
      description:
        "提交本步骤的结果。开发在测试通过后提交 pass；Review 按漏洞和验收标准提交 pass 或 reject；DevOps 全部推送成功提交 pass，有仓库失败提交 reject。reject 的 comments 必须写明修改建议或失败原因，不能为空。",
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
        const comments = typeof args.comments === "string" ? args.comments : "";
        if (verdict === "reject" && !comments.trim()) {
          return { content: [{ type: "text", text: "reject 必须在 comments 里写明审核建议" }], isError: true };
        }
        record({ verdict, comments });
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
      const comments = parsed.comments ?? "";
      if (parsed.verdict === "reject" && !comments.trim()) return null;
      return { verdict: parsed.verdict, comments };
    }
  } catch {
    return null;
  }
  return null;
}

export function toLoopEvent(step: StepId, result: StepResult | null): LoopEvent {
  if (!result) return { type: "techError" };
  if (result.verdict === "need_input") return { type: "needInput", question: result.question };
  if (result.verdict === "reject" && !result.comments.trim()) return { type: "techError" };
  const pass = result.verdict === "pass";
  if (step === "review") return { type: "review", pass };
  if (step === "devops") return { type: "devops", results: [pass] };
  return { type: "stepOk" };
}

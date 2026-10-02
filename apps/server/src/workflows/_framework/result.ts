import type { GatewayTool } from "../../runs.js";
import type { ChoiceQuestion, LoopEvent, StepId } from "../cursor-dev-loop/next.js";

export type StepResult =
  | { verdict: "pass" | "reject"; comments: string }
  | { verdict: "need_input"; question: string; questions?: ChoiceQuestion[] };

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
      description:
        "遇到必须由用户决定的问题时调用。必须带 questions：每题有 id、prompt，以及可点选的 options（每项有 id 和 label）。不要只把选项写在正文里。调用后立即结束本轮回复，等待用户回答后会在同一个对话里继续。",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string" },
          title: { type: "string" },
          questions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                prompt: { type: "string" },
                allowMultiple: { type: "boolean" },
                options: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      label: { type: "string" },
                    },
                    required: ["id", "label"],
                  },
                },
              },
              required: ["id", "prompt", "options"],
            },
          },
        },
      },
      execute(args) {
        const questions = normalizeQuestions(args.questions);
        const legacy = typeof args.question === "string" ? args.question.trim() : "";
        const title = typeof args.title === "string" ? args.title.trim() : "";
        const question = title || legacy || questions.map((item) => item.prompt).join("\n");
        if (!question) return { content: [{ type: "text", text: "question 不能为空" }], isError: true };
        record({ verdict: "need_input", question, ...(questions.length ? { questions } : {}) });
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
    const parsed = JSON.parse(last) as { verdict?: string; comments?: string; question?: string; questions?: unknown };
    if (parsed.verdict === "need_input") {
      const questions = normalizeQuestions(parsed.questions);
      const question = (typeof parsed.question === "string" ? parsed.question.trim() : "") || questions.map((item) => item.prompt).join("\n");
      if (!question) return null;
      return { verdict: "need_input", question, ...(questions.length ? { questions } : {}) };
    }
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

export function normalizeQuestions(value: unknown): ChoiceQuestion[] {
  if (!Array.isArray(value)) return [];
  const questions: ChoiceQuestion[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
    if (!prompt || !Array.isArray(raw.options)) continue;
    const options: ChoiceQuestion["options"] = [];
    for (const option of raw.options) {
      if (!option || typeof option !== "object") continue;
      const entry = option as Record<string, unknown>;
      const id = typeof entry.id === "string" ? entry.id.trim() : "";
      const label = typeof entry.label === "string" ? entry.label.trim() : "";
      if (!id || !label || id === "other") continue;
      if (options.some((current) => current.id === id)) continue;
      options.push({ id, label });
    }
    if (!options.length) continue;
    let id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `q${questions.length + 1}`;
    if (questions.some((current) => current.id === id)) id = `${id}-${questions.length + 1}`;
    questions.push({
      id,
      prompt,
      options,
      ...(raw.allowMultiple === true ? { allowMultiple: true } : {}),
    });
  }
  return questions;
}

export function toLoopEvent(step: StepId, result: StepResult | null): LoopEvent {
  if (!result) return { type: "techError" };
  if (result.verdict === "need_input") {
    return { type: "needInput", question: result.question, ...(result.questions?.length ? { questions: result.questions } : {}) };
  }
  if (result.verdict === "reject" && !result.comments.trim()) return { type: "techError" };
  const pass = result.verdict === "pass";
  if (step === "plan" && !pass) return { type: "techError" };
  if (step === "review") return { type: "review", pass };
  if (step === "devops") return { type: "devops", results: [pass] };
  return { type: "stepOk" };
}

import type { RequirementCard } from "@gateway/shared";
import type { StepId } from "./next.js";

const resultRule = `完成后必须调用 submit_verdict 工具提交结果。遇到必须由用户决定的问题时调用 ask_user，然后立即结束本轮回复。
ask_user 必须带 questions：每题有 id、prompt，以及可点选的 options（每项有 id 和 label）。不要只把选项写在正文里。
如果工具不可用，就在回复最后单独输出一行：<gateway-result>{"verdict":"pass|reject|need_input","comments":"...","question":"...","questions":[{"id":"q1","prompt":"...","options":[{"id":"a","label":"..."}]}]}</gateway-result>`;

const stepGuide: Record<StepId, string> = {
  plan: `你是计划。根据需求卡和已有意见写出实现计划，不要修改任何文件。
计划必须按 TDD 排列：
1. 先写哪些会失败的测试，以及如何运行并确认失败。
2. 再改哪些文件，直到这些测试通过。
完成后用 submit_verdict 提交 pass，comments 写完整计划。`,
  develop: `你是开发。严格按照上一步的计划执行，只做这张卡范围内的改动，不要提交或推送代码。
计划做完并且测试通过后，用 submit_verdict 提交 pass，comments 写测试命令和结果。`,
  review: `你是 Review。只审查本次代码改动和其中涉及的文件，不要搜索或通读整个代码仓库。
对照需求卡的验收标准逐条判断是否满足，并检查改动里的代码漏洞。
有任何代码漏洞，或任何一条验收标准不符合，都提交 reject。comments 必须逐条写明漏洞或不符的验收项，以及具体修改建议。没有修改建议的 reject 无效。
diff 不足以判断某条验收标准时，在 comments 里指出缺少的证据并 reject。
全部符合且没有漏洞时提交 pass。`,
  devops: `你是 DevOps。对 workspace 下每个有改动的 git 仓库，在当前分支上 commit（提交信息概括这张卡）并 push，禁止强制推送。
全部成功提交 pass；任何仓库失败提交 reject，comments 写明失败的仓库和错误信息。`,
};

export function stepPrompt(input: {
  step: StepId;
  card: RequirementCard;
  sharedContext: string;
  note: string;
  comments?: string;
  firstTurn: boolean;
  diff?: string;
}): string {
  const parts: string[] = [`## 当前步骤：${input.step}`, stepGuide[input.step]];
  if (input.firstTurn || input.step === "review" || input.step === "plan") {
    parts.push(cardText(input.card, input.sharedContext));
  } else {
    parts.push(`需求卡：${input.card.title}（完整内容见本对话开头）`);
  }
  if (input.step === "review" && input.diff) parts.push(input.diff);
  if (input.note) parts.push(`调度说明：${input.note}`);
  if (input.comments) parts.push(`上一步的意见：\n${input.comments}`);
  parts.push(resultRule);
  return parts.join("\n\n");
}

function cardText(card: RequirementCard, sharedContext: string): string {
  const lines = [
    `## 需求卡：${card.title}`,
    `目标：${card.goal}`,
    `背景：${card.context}`,
    `验收标准：\n${card.acceptanceCriteria.map((item, index) => `${index + 1}. ${item}`).join("\n")}`,
  ];
  if (card.relevantPaths?.length) lines.push(`相关路径：${card.relevantPaths.join("，")}`);
  if (sharedContext) lines.push(`整体背景：${sharedContext}`);
  return lines.join("\n");
}

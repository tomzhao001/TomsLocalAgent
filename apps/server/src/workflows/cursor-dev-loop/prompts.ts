import type { RequirementCard } from "@gateway/shared";
import type { StepId } from "./next.js";

const resultRule = `完成后必须调用 submit_verdict 工具提交结果；遇到必须由用户决定的问题时调用 ask_user 工具，然后立即结束本轮回复。
如果工具不可用，就在回复最后单独输出一行：<gateway-result>{"verdict":"pass|reject|need_input","comments":"...","question":"..."}</gateway-result>`;

const stepGuide: Record<StepId, string> = {
  develop: `你是开发。按需求卡实现功能并补充必要的测试，只做这张卡范围内的改动，不要提交或推送代码。
完成后用 submit_verdict 提交 pass，comments 写改动摘要。`,
  arch: `你是架构审核。审查这张卡目前的代码改动（可以用 git diff 查看），检查设计是否合理、是否超出范围、是否有明显缺陷。
通过提交 pass；不通过提交 reject，comments 逐条写出需要修改的地方。`,
  qa: `你是 QA。对照验收标准运行测试和检查命令，确认功能达标。不要修改任何代码。
全部达标提交 pass；不达标提交 reject，comments 写出失败的验收项和复现方式。`,
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
}): string {
  const parts: string[] = [`## 当前步骤：${input.step}`, stepGuide[input.step]];
  if (input.firstTurn) {
    parts.push(cardText(input.card, input.sharedContext));
  } else {
    parts.push(`需求卡：${input.card.title}（完整内容见本对话开头）`);
  }
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

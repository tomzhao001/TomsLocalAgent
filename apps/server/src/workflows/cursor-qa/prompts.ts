import type { RequirementCard } from "@gateway/shared";

const resultRule = `完成后必须调用 submit_verdict 工具提交结果。遇到必须由用户决定的问题时调用 ask_user，然后立即结束本轮回复。
ask_user 必须带 questions：每题有 id、prompt，以及可点选的 options（每项有 id 和 label）。不要只把选项写在正文里。
如果工具不可用，就在回复最后单独输出一行：<gateway-result>{"verdict":"pass|reject|need_input","comments":"...","question":"...","questions":[{"id":"q1","prompt":"...","options":[{"id":"a","label":"..."}]}]}</gateway-result>`;

export function qaPrompt(input: {
  card: RequirementCard;
  sharedContext: string;
  note: string;
  comments?: string;
  firstTurn: boolean;
}): string {
  const parts = [
    "## 当前步骤：qa",
    `你是 QA。按需求卡的验收标准运行端到端测试。可以启动服务、执行测试命令，禁止修改源代码或配置，禁止提交或推送。
全部通过才提交 pass，comments 写测试命令和结果。
有任何失败都提交 reject，comments 写失败项、命令和关键输出。comments 为空的 reject 无效。`,
  ];
  if (input.firstTurn) parts.push(cardText(input.card, input.sharedContext));
  else parts.push(`需求卡：${input.card.title}（完整内容见本对话开头）`);
  if (input.note) parts.push(`调度说明：${input.note}`);
  if (input.comments) parts.push(`上一次的结果：\n${input.comments}`);
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

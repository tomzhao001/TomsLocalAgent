export type AccessProfile = "chat" | "split" | "plan" | "develop" | "review" | "qa" | "devops";

export type CursorAccess = {
  mode: "agent" | "plan";
  tools?: string[];
  rules: string;
};

const readTools = ["read", "grep", "glob", "ls", "semSearch", "readLints"];

const readonlyRules =
  "【纪律】本次运行是只读的：禁止创建、修改、删除 workspace 里的任何文件，禁止执行会改动仓库或系统状态的命令。只能阅读代码和回答问题。";

export const cursorAccess: Record<AccessProfile, CursorAccess> = {
  chat: {
    mode: "plan",
    tools: [...readTools, "webSearch", "webFetch"],
    rules: readonlyRules,
  },
  split: {
    mode: "agent",
    tools: [...readTools, "mcp"],
    rules: `${readonlyRules}拆卡结果只能通过 submit_requirements 工具提交，由 Gateway 写入数据库。`,
  },
  plan: {
    mode: "plan",
    tools: [...readTools, "mcp"],
    rules: "【纪律】你现在是 Plan，只写实现计划，禁止修改任何文件，禁止执行会改动仓库或系统状态的命令。",
  },
  develop: {
    mode: "agent",
    rules: "",
  },
  review: {
    mode: "agent",
    tools: [...readTools, "mcp"],
    rules: "【纪律】你现在是 Review，只读本次改动并对照验收标准给出判定，禁止修改任何文件，禁止搜索或通读整个代码仓库。",
  },
  qa: {
    mode: "agent",
    tools: [...readTools, "shell", "mcp"],
    rules: "【纪律】你现在是 QA，只运行端到端测试和检查命令，禁止修改任何源代码或配置文件，禁止提交或推送。",
  },
  devops: {
    mode: "agent",
    tools: [...readTools, "shell", "mcp"],
    rules: "【纪律】你现在是 DevOps，只负责提交和推送，禁止修改代码内容，禁止强制推送。",
  },
};

export function withRules(profile: AccessProfile, prompt: string): string {
  return promptWithRules(cursorAccess[profile], prompt);
}

export function accessForChat(mode: "ask" | "plan" | "agent" | undefined): CursorAccess {
  if (mode === "agent") return { mode: "agent", rules: "" };
  if (mode === "plan" || mode === "ask") {
    return { mode: "plan", tools: [...readTools, "webSearch", "webFetch"], rules: "" };
  }
  return cursorAccess.chat;
}

export function promptWithRules(access: CursorAccess, prompt: string): string {
  return access.rules ? `${access.rules}\n\n${prompt}` : prompt;
}

export const opencodeReadonly = {
  agent: "plan",
  tools: { write: false, edit: false, patch: false, bash: false },
  permission: { edit: "deny", bash: "deny", webfetch: "allow" },
} as const;

export type RunStatus = "running" | "finished" | "error" | "cancelled";

export type TokenUsage = {
  totalTokens: number;
  inputTokens?: number;
  outputTokens?: number;
};

export type GatewayEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool-start"; callId: string; name: string }
  | { type: "tool-end"; callId: string; name: string }
  | { type: "usage"; usage: TokenUsage }
  | { type: "done"; status: Exclude<RunStatus, "running"> }
  | { type: "error"; message: string };

export type ProviderId = "cursor" | "opencode";

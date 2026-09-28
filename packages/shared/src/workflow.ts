export const requirementStatuses = ["pending", "running", "waiting_input", "delivered", "aborted"] as const;

export type RequirementStatus = (typeof requirementStatuses)[number];

export const splitStatuses = ["running", "draft", "confirmed", "failed", "discarded"] as const;

export type SplitStatus = (typeof splitStatuses)[number];

export const stepRunStatuses = ["running", "finished", "error", "cancelled", "interrupted"] as const;

export type StepRunStatus = (typeof stepRunStatuses)[number];

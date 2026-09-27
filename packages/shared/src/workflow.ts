export const workflowStatuses = [
  "splitting",
  "awaiting_confirm",
  "running",
  "waiting_input",
  "done",
  "aborted",
] as const;

export type WorkflowStatus = (typeof workflowStatuses)[number];

export const requirementStatuses = ["pending", "in_progress", "delivered"] as const;

export type RequirementStatus = (typeof requirementStatuses)[number];

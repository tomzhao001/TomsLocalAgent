export type WorkflowConfig = {
  models: Record<string, string>;
  reviewRejectLimit: number;
};

export const defaultWorkflowConfig: WorkflowConfig = {
  models: { develop: "composer-2.5", review: "composer-2.5", devops: "composer-2.5" },
  reviewRejectLimit: 3,
};

export function snapshotConfig(override: Partial<WorkflowConfig> | null): WorkflowConfig {
  return {
    models: { ...defaultWorkflowConfig.models, ...override?.models },
    reviewRejectLimit: override?.reviewRejectLimit ?? defaultWorkflowConfig.reviewRejectLimit,
  };
}

export function modelForRunningStep(stepModel: string, config: WorkflowConfig, step: string): string {
  return stepModel || config.models[step] || defaultWorkflowConfig.models.develop;
}

export function isDangerousCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return /git\s+push\b[\s\S]*--force/.test(normalized) || /rm\s+-rf\b/.test(normalized);
}

export function isStalled(lastEventAt: number, now: number, limitMs: number): boolean {
  return now - lastEventAt > limitMs;
}

export async function ensureOpenCode(health: () => Promise<boolean>, restart: () => Promise<void>): Promise<void> {
  if (!(await health())) await restart();
}

export type WorkflowConfig = {
  models: Record<string, string>;
  archRejectLimit: number;
  qaRejectLimit: number;
};

export const defaultWorkflowConfig: WorkflowConfig = {
  models: { develop: "composer-2.5", arch: "composer-2.5", qa: "composer-2.5", devops: "composer-2.5" },
  archRejectLimit: 3,
  qaRejectLimit: 2,
};

export function snapshotConfig(override: Partial<WorkflowConfig> | null): WorkflowConfig {
  return {
    models: { ...defaultWorkflowConfig.models, ...override?.models },
    archRejectLimit: override?.archRejectLimit ?? defaultWorkflowConfig.archRejectLimit,
    qaRejectLimit: override?.qaRejectLimit ?? defaultWorkflowConfig.qaRejectLimit,
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

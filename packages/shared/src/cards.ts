import { z } from "zod";

export const requirementCardSchema = z.object({
  title: z.string().min(1),
  goal: z.string().min(1),
  context: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  relevantPaths: z.array(z.string()).optional(),
  dependsOn: z.array(z.number().int().nonnegative()).optional(),
});

export type RequirementCard = z.infer<typeof requirementCardSchema>;

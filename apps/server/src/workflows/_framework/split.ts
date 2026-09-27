import { requirementCardSchema, type RequirementCard } from "@gateway/shared";
import { z } from "zod";

const splitResultSchema = z.object({
  sharedContext: z.string().min(1),
  cards: z.array(requirementCardSchema).min(1),
});

export function acceptRequirements(input: unknown): { ok: true; sharedContext: string; cards: RequirementCard[] } | { ok: false; error: string } {
  const parsed = splitResultSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((issue) => issue.message).join("; ") };
  return { ok: true, sharedContext: parsed.data.sharedContext, cards: parsed.data.cards };
}

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type WorkflowDefinition = {
  id: string;
  type: "cursor" | "opencode";
  name: string;
};

export async function discoverWorkflows(root: string): Promise<WorkflowDefinition[]> {
  if (!existsSync(root)) return [];
  const found: WorkflowDefinition[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    const index = join(root, entry.name, "index.ts");
    if (!existsSync(index)) continue;
    const mod = (await import(pathToFileURL(index).href)) as { definition?: WorkflowDefinition };
    if (mod.definition) found.push(mod.definition);
  }
  return found;
}

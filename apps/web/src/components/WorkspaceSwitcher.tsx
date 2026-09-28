import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Workspace, WorkspaceStatus } from "@/lib/api";

export type Attention = "waiting" | "running" | "idle";

export function attentionOf(status: WorkspaceStatus | undefined): Attention {
  if (!status) return "idle";
  if (status.status === "waiting_input" || status.drafts > 0) return "waiting";
  if (status.status === "running") return "running";
  return "idle";
}

const rank: Record<Attention, number> = { waiting: 0, running: 1, idle: 2 };

export function sortWorkspaces(workspaces: Workspace[], statuses: WorkspaceStatus[]): Workspace[] {
  const byId = new Map(statuses.map((item) => [item.workspaceId, item]));
  return [...workspaces].sort((a, b) => rank[attentionOf(byId.get(a.id))] - rank[attentionOf(byId.get(b.id))]);
}

export function StatusDot({ attention, label }: { attention: Attention; label?: string }) {
  if (attention === "idle") return null;
  const text = label ?? (attention === "waiting" ? "等待你处理" : "运行中");
  return (
    <span
      role="img"
      aria-label={text}
      title={text}
      className={`inline-block size-2 shrink-0 rounded-full ${attention === "waiting" ? "bg-amber-500" : "bg-emerald-500"}`}
    />
  );
}

export function WorkspaceSwitcher(props: {
  workspaces: Workspace[];
  statuses: WorkspaceStatus[];
  value: string;
  onChange: (id: string) => void;
}) {
  const byId = new Map(props.statuses.map((item) => [item.workspaceId, item]));
  return (
    <Select value={props.value} onValueChange={props.onChange}>
      <SelectTrigger className="max-w-[55vw] min-w-36" aria-label="切换 Workspace">
        <SelectValue placeholder="选择 Workspace" />
      </SelectTrigger>
      <SelectContent>
        {sortWorkspaces(props.workspaces, props.statuses).map((item) => (
          <SelectItem key={item.id} value={item.id}>
            <span className="flex items-center gap-2">
              <StatusDot attention={attentionOf(byId.get(item.id))} />
              <span className="truncate">{item.name}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

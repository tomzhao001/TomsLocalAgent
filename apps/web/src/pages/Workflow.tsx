import { GitBranchPlus, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RequirementDialog } from "@/components/workflow/RequirementDialog";
import { RequirementList } from "@/components/workflow/RequirementList";
import { SplitDialog } from "@/components/workflow/SplitDialog";
import { SplitTasks } from "@/components/workflow/SplitTasks";
import { api, type Feature, type Requirement, type SplitTask } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";

type Snapshot = { items: Requirement[]; features: Feature[] };
type HistoryPage = Snapshot & { hasMore: boolean };

export function WorkflowPage(props: { workspaceId: string; active: boolean; onChanged: () => void }) {
  const { workspaceId } = props;
  const [view, setView] = useState<"active" | "history">("active");
  const [snapshot, setSnapshot] = useState<Snapshot>({ items: [], features: [] });
  const [splits, setSplits] = useState<SplitTask[]>([]);
  const [history, setHistory] = useState<HistoryPage>({ items: [], features: [], hasMore: false });
  const [error, setError] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);

  const loadActive = useCallback(async () => {
    try {
      const [next, nextSplits] = await Promise.all([
        api<Snapshot>(`/api/workspaces/${workspaceId}/requirements?scope=active`),
        api<SplitTask[]>(`/api/workspaces/${workspaceId}/splits`),
      ]);
      setSnapshot(next);
      setSplits(nextSplits);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取失败");
    }
  }, [workspaceId]);

  const loadHistory = useCallback(
    async (more = false) => {
      try {
        const before = more ? history.items.at(-1)?.finishedAt : undefined;
        const page = await api<HistoryPage>(
          `/api/workspaces/${workspaceId}/requirements?scope=history${before ? `&before=${before}` : ""}`,
        );
        setHistory((current) =>
          more
            ? { items: [...current.items, ...page.items], features: mergeFeatures(current.features, page.features), hasMore: page.hasMore }
            : page,
        );
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "读取失败");
      }
    },
    [workspaceId, history.items],
  );

  usePolling(loadActive, 10_000, props.active && view === "active");

  useEffect(() => {
    if (props.active && view === "history") void loadHistory();
  }, [props.active, view]);

  function changed() {
    void loadActive();
    props.onChanged();
  }

  const empty = snapshot.items.length === 0 && splits.length === 0;

  return (
    <section className="flex flex-col gap-3">
      <Tabs value={view} onValueChange={(value) => setView(value as "active" | "history")}>
        <div className="flex flex-wrap items-center gap-2">
          <TabsList>
            <TabsTrigger value="active">进行中</TabsTrigger>
            <TabsTrigger value="history">已完成</TabsTrigger>
          </TabsList>
          {view === "active" ? (
            <div className="ml-auto flex gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => setSplitOpen(true)}>
                <GitBranchPlus data-icon="inline-start" />
                拆卡
              </Button>
              <Button type="button" size="sm" onClick={() => setAddOpen(true)}>
                <Plus data-icon="inline-start" />
                新增需求
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="ml-auto"
              aria-label="刷新已完成"
              onClick={() => void loadHistory()}
            >
              <RefreshCw />
            </Button>
          )}
        </div>
        <TabsContent value="active" className="flex flex-col gap-4 pt-2">
          <SplitTasks splits={splits} onChanged={changed} />
          <RequirementList items={snapshot.items} features={snapshot.features} onChanged={changed} />
          {empty ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              队列是空的。可以在聊天里把讨论「转为工作流」，也可以直接拆卡或新增需求。
            </p>
          ) : null}
        </TabsContent>
        <TabsContent value="history" className="flex flex-col gap-4 pt-2">
          <RequirementList items={history.items} features={history.features} readOnly onChanged={() => void loadHistory()} />
          {history.items.length === 0 ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">还没有完成的需求卡</p>
          ) : null}
          {history.hasMore ? (
            <Button type="button" variant="outline" onClick={() => void loadHistory(true)}>
              加载更多
            </Button>
          ) : null}
        </TabsContent>
      </Tabs>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <RequirementDialog open={addOpen} onOpenChange={setAddOpen} workspaceId={workspaceId} onCreated={changed} />
      <SplitDialog open={splitOpen} onOpenChange={setSplitOpen} workspaceId={workspaceId} onStarted={changed} />
    </section>
  );
}

function mergeFeatures(current: Feature[], next: Feature[]): Feature[] {
  const ids = new Set(current.map((item) => item.id));
  return [...current, ...next.filter((item) => !ids.has(item.id))];
}

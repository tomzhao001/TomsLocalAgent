import { useEffect, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { StepRun } from "@/lib/api";
import { LogView } from "./LogView";

const runStatusLabels: Record<StepRun["status"], string> = {
  running: "运行中",
  finished: "已结束",
  error: "出错",
  cancelled: "已取消",
  interrupted: "中断",
};

export function planText(run: StepRun): string | null {
  if (run.step !== "plan" || !run.result || run.result.verdict !== "pass") return null;
  const text = run.result.comments.trim();
  return text || null;
}

export function planForRun(run: StepRun, planRuns: StepRun[]): string | null {
  if (run.step === "plan") return planText(run);
  if (run.step !== "develop") return null;
  const prior = planRuns
    .filter((item) => item.startedAt < run.startedAt)
    .sort((a, b) => a.startedAt - b.startedAt || a.attempt - b.attempt);
  for (let index = prior.length - 1; index >= 0; index -= 1) {
    const text = planText(prior[index]!);
    if (text) return text;
  }
  return null;
}

function resultLine(run: StepRun): string | null {
  if (!run.result) return null;
  if (run.result.verdict === "need_input") return `提问：${run.result.question}`;
  const label = run.result.verdict === "pass" ? "通过" : "不通过";
  if (run.step === "plan" && run.result.verdict === "pass") return label;
  return run.result.comments.trim() ? `${label}：${run.result.comments}` : label;
}

export function StepLogPanel({ runs, planRuns = [] }: { runs: StepRun[]; planRuns?: StepRun[] }) {
  const [selected, setSelected] = useState<string | null>(runs.at(-1)?.id ?? null);
  const [planOpen, setPlanOpen] = useState(false);

  useEffect(() => {
    if (!runs.some((run) => run.id === selected)) setSelected(runs.at(-1)?.id ?? null);
  }, [runs, selected]);

  const run = runs.find((item) => item.id === selected);
  const plan = run ? planForRun(run, planRuns) : null;
  const summary = run ? resultLine(run) : null;

  useEffect(() => {
    setPlanOpen(false);
  }, [run?.id]);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {runs.map((item) => (
          <Button
            key={item.id}
            type="button"
            size="xs"
            variant={item.id === selected ? "secondary" : "ghost"}
            onClick={() => setSelected(item.id)}
          >
            第 {item.attempt} 轮
          </Button>
        ))}
      </div>
      {!run ? <p className="text-xs text-muted-foreground">这一步还没有执行过</p> : null}
      {run ? (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">{runStatusLabels[run.status]}</Badge>
            <span>{new Date(run.startedAt).toLocaleString()}</span>
            {run.note ? <span>调度说明：{run.note}</span> : null}
            {plan ? (
              <Button type="button" size="xs" variant="outline" onClick={() => setPlanOpen(true)}>
                查看 Plan
              </Button>
            ) : null}
          </div>
          {summary ? <p className="min-w-0 rounded-md bg-muted px-2 py-1.5 text-xs wrap-break-word whitespace-pre-wrap">{summary}</p> : null}
          <LogView url={`/api/step-runs/${run.id}/log`} running={run.status === "running"} scroll={false} />
          <Dialog open={planOpen} onOpenChange={setPlanOpen}>
            <DialogContent className="max-h-[min(85svh,40rem)] min-w-0 overflow-x-hidden overflow-y-auto sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>Plan</DialogTitle>
                <DialogDescription className="sr-only">这一轮对应的计划</DialogDescription>
              </DialogHeader>
              {plan ? <Markdown text={plan} /> : null}
            </DialogContent>
          </Dialog>
        </>
      ) : null}
    </div>
  );
}

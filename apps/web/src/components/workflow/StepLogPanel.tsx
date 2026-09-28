import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { stepLabels, type StepId, type StepRun } from "@/lib/api";
import { LogView } from "./LogView";

const runStatusLabels: Record<StepRun["status"], string> = {
  running: "运行中",
  finished: "已结束",
  error: "出错",
  cancelled: "已取消",
  interrupted: "中断",
};

export function StepLogPanel({ step, runs }: { step: StepId; runs: StepRun[] }) {
  const [selected, setSelected] = useState<string | null>(runs.at(-1)?.id ?? null);

  useEffect(() => {
    if (!runs.some((run) => run.id === selected)) setSelected(runs.at(-1)?.id ?? null);
  }, [runs, selected]);

  const run = runs.find((item) => item.id === selected);

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-sm">{stepLabels[step]} 日志</strong>
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
          </div>
          {run.result ? (
            <p className="rounded-md bg-muted px-2 py-1.5 text-xs whitespace-pre-wrap">
              {run.result.verdict === "need_input"
                ? `提问：${run.result.question}`
                : `${run.result.verdict === "pass" ? "通过" : "不通过"}${run.result.comments ? `：${run.result.comments}` : ""}`}
            </p>
          ) : null}
          <LogView url={`/api/step-runs/${run.id}/log`} running={run.status === "running"} />
        </>
      ) : null}
    </div>
  );
}

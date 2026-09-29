import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { InputAction, WaitInfo } from "@/lib/api";

const waitTitles: Record<WaitInfo["kind"], string> = {
  question: "需要你回答",
  limit: "打回次数超过上限",
  pushFailed: "推送失败",
  techError: "连续出现技术错误",
  qaFailed: "E2E 未通过",
};

function actionLabel(action: InputAction, kind: WaitInfo["kind"]): string {
  if (action === "answer") return kind === "question" ? "回答" : kind === "pushFailed" ? "重试推送" : "重试";
  if (action === "continue") return "继续修改";
  if (action === "forcePass") return "强制通过";
  return "终止";
}

export function WaitForm(props: { wait: WaitInfo; onSubmit: (action: InputAction, text: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const { wait } = props;

  async function submit(action: InputAction) {
    setBusy(true);
    setError("");
    try {
      await props.onSubmit(action, text.trim());
      setSubmitted(true);
      setText("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "提交失败");
    } finally {
      setBusy(false);
    }
  }

  const needsText = (action: InputAction) => action === "continue" || (action === "answer" && wait.kind === "question");

  return (
    <div role="alert" className="nodrag nopan nowheel flex flex-col gap-2 rounded-lg border border-amber-500/60 bg-amber-50 p-2 text-left text-xs">
      <strong>{waitTitles[wait.kind]}</strong>
      <p className="whitespace-pre-wrap">{wait.message}</p>
      {wait.comments ? <p className="whitespace-pre-wrap text-muted-foreground">最近意见：{wait.comments}</p> : null}
      {submitted ? <p className="text-emerald-700">已提交，将在下一次调度时继续</p> : null}
      <Textarea
        aria-label="你的输入"
        className="min-h-16 bg-background text-xs"
        value={text}
        placeholder={wait.kind === "question" ? "输入你的回答" : "补充说明（可选）"}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="flex flex-wrap gap-1.5">
        {wait.options.map((action) => (
          <Button
            key={action}
            type="button"
            size="xs"
            variant={action === "abort" ? "destructive" : action === "forcePass" ? "outline" : "default"}
            disabled={busy || (needsText(action) && !text.trim())}
            onClick={() => void submit(action)}
          >
            {actionLabel(action, wait.kind)}
          </Button>
        ))}
      </div>
      {error ? <p className="text-destructive">{error}</p> : null}
    </div>
  );
}

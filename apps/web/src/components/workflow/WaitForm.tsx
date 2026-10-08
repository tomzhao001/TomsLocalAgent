import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { ChoiceQuestion, InputAction, WaitInfo } from "@/lib/api";

const waitTitles: Record<WaitInfo["kind"], string> = {
  question: "需要你回答",
  limit: "打回次数超过上限",
  pushFailed: "推送失败",
  techError: "连续出现技术错误",
  qaFailed: "E2E 未通过",
};

const otherId = "other";

function replyAction(kind: WaitInfo["kind"]): InputAction {
  return kind === "limit" ? "continue" : "answer";
}

function pickedOf(selected: Record<string, string[]>, id: string): string[] {
  return selected[id] ?? [];
}

function canSend(wait: WaitInfo, selected: Record<string, string[]>, otherText: Record<string, string>, plain: string): boolean {
  const questions = wait.questions ?? [];
  if (questions.length === 0) {
    if (wait.kind === "question" || wait.kind === "limit") return plain.trim().length > 0;
    return true;
  }
  return questions.every((question) => {
    const picked = pickedOf(selected, question.id);
    const choices = picked.filter((id) => id !== otherId);
    const other = picked.includes(otherId);
    if (choices.length === 0 && !other) return false;
    if (other && !(otherText[question.id] ?? "").trim()) return false;
    return true;
  });
}

function composeReply(wait: WaitInfo, selected: Record<string, string[]>, otherText: Record<string, string>, plain: string): string {
  const questions = wait.questions ?? [];
  if (questions.length === 0) return plain.trim();
  return questions
    .map((question) => {
      const picked = pickedOf(selected, question.id);
      const labels = question.options.filter((option) => picked.includes(option.id)).map((option) => option.label);
      if (picked.includes(otherId)) {
        const text = (otherText[question.id] ?? "").trim();
        if (text) labels.push(text);
      }
      const value = labels.join("、");
      return questions.length === 1 ? value : `${question.prompt}：${value}`;
    })
    .join("\n");
}

export function WaitForm(props: { wait: WaitInfo; onSubmit: (action: InputAction, text: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [plain, setPlain] = useState("");
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const { wait } = props;
  const questions = wait.questions ?? [];

  function reset() {
    setPlain("");
    setSelected({});
    setOtherText({});
    setError("");
    setSubmitted(false);
  }

  function toggle(question: ChoiceQuestion, optionId: string) {
    setSelected((current) => {
      const picked = pickedOf(current, question.id);
      const next = question.allowMultiple
        ? picked.includes(optionId)
          ? picked.filter((id) => id !== optionId)
          : [...picked, optionId]
        : [optionId];
      return { ...current, [question.id]: next };
    });
  }

  async function submit() {
    setBusy(true);
    setError("");
    try {
      await props.onSubmit(replyAction(wait.kind), composeReply(wait, selected, otherText, plain));
      setSubmitted(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "提交失败");
    } finally {
      setBusy(false);
    }
  }

  const ready = canSend(wait, selected, otherText, plain);

  return (
    <>
      <div>
        <Button type="button" size="sm" onClick={() => { reset(); setOpen(true); }}>
          处理
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[min(85svh,40rem)] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{waitTitles[wait.kind]}</DialogTitle>
            <DialogDescription className="wrap-break-word whitespace-pre-wrap text-foreground">{wait.message}</DialogDescription>
          </DialogHeader>
          {wait.comments ? <p className="wrap-break-word whitespace-pre-wrap text-muted-foreground">补充信息：{wait.comments}</p> : null}
          {questions.map((question) => {
            const picked = pickedOf(selected, question.id);
            return (
              <fieldset key={question.id} className="flex min-w-0 flex-col gap-2">
                <legend className="wrap-break-word text-sm font-medium">{question.prompt}</legend>
                <div className="flex min-w-0 flex-wrap gap-1.5">
                  {question.options.map((option) => (
                    <Button
                      key={option.id}
                      type="button"
                      size="sm"
                      variant={picked.includes(option.id) ? "default" : "outline"}
                      className="inline-block! h-auto max-w-full min-w-0 text-left whitespace-normal! wrap-anywhere"
                      aria-pressed={picked.includes(option.id)}
                      onClick={() => toggle(question, option.id)}
                    >
                      {option.label}
                    </Button>
                  ))}
                  <Button
                    type="button"
                    size="sm"
                    variant={picked.includes(otherId) ? "default" : "outline"}
                    className="inline-block! h-auto max-w-full min-w-0 text-left whitespace-normal! wrap-anywhere"
                    aria-pressed={picked.includes(otherId)}
                    onClick={() => toggle(question, otherId)}
                  >
                    Other
                  </Button>
                </div>
                {picked.includes(otherId) ? (
                  <Textarea
                    aria-label={`${question.prompt}的其他回答`}
                    className="min-h-16"
                    value={otherText[question.id] ?? ""}
                    placeholder="输入其他回答"
                    onChange={(event) => setOtherText((current) => ({ ...current, [question.id]: event.target.value }))}
                  />
                ) : null}
              </fieldset>
            );
          })}
          {questions.length === 0 ? (
            <Textarea
              aria-label="你的输入"
              className="min-h-16"
              value={plain}
              placeholder={wait.kind === "question" ? "输入你的回答" : wait.kind === "limit" ? "补充说明" : "补充说明（可选）"}
              onChange={(event) => setPlain(event.target.value)}
            />
          ) : null}
          {submitted ? <p className="text-emerald-700">已提交，将在下一次调度时继续</p> : null}
          {error ? <p className="text-destructive">{error}</p> : null}
          <Button type="button" disabled={busy || submitted || !ready} onClick={() => void submit()}>
            发送
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}

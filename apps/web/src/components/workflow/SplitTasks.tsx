import { Trash2 } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, type RequirementCard, type SplitTask } from "@/lib/api";
import { LogView } from "./LogView";
import { lines } from "./RequirementDialog";

export function SplitTasks({ splits, onChanged }: { splits: SplitTask[]; onChanged: () => void }) {
  if (splits.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {splits.map((split) =>
        split.status === "draft" && split.draft ? (
          <DraftEditor key={split.id} split={split} draft={split.draft} onChanged={onChanged} />
        ) : (
          <SplitStatus key={split.id} split={split} onChanged={onChanged} />
        ),
      )}
    </div>
  );
}

function SplitStatus({ split, onChanged }: { split: SplitTask; onChanged: () => void }) {
  const [showLog, setShowLog] = useState(false);
  const running = split.status === "running";
  return (
    <Alert variant={running ? "default" : "destructive"}>
      <AlertTitle>{running ? "拆卡中…" : "拆卡失败"}</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <p className="line-clamp-2">{split.prompt}</p>
        {split.error ? <p>{split.error}</p> : null}
        <div className="flex gap-2">
          <Button type="button" size="xs" variant="outline" onClick={() => setShowLog((value) => !value)}>
            {showLog ? "收起日志" : "查看日志"}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => void api(`/api/splits/${split.id}/discard`, { method: "POST" }).then(onChanged)}
          >
            {running ? "取消" : "清除"}
          </Button>
        </div>
        {showLog ? <LogView url={`/api/splits/${split.id}/log`} running={running} /> : null}
      </AlertDescription>
    </Alert>
  );
}

type EditableCard = { title: string; goal: string; context: string; criteria: string; extra: Partial<RequirementCard> };

function toEditable(card: RequirementCard): EditableCard {
  const { title, goal, context, acceptanceCriteria, ...extra } = card;
  return { title, goal, context, criteria: acceptanceCriteria.join("\n"), extra };
}

function DraftEditor(props: { split: SplitTask; draft: NonNullable<SplitTask["draft"]>; onChanged: () => void }) {
  const [title, setTitle] = useState(() => props.split.prompt.split(/\r?\n/)[0]?.slice(0, 40) ?? "");
  const [sharedContext, setSharedContext] = useState(props.draft.sharedContext);
  const [cards, setCards] = useState<EditableCard[]>(() => props.draft.cards.map(toEditable));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function update(index: number, patch: Partial<EditableCard>) {
    setCards((current) => current.map((card, i) => (i === index ? { ...card, ...patch } : card)));
  }

  async function confirm() {
    setError("");
    setBusy(true);
    try {
      await api(`/api/splits/${props.split.id}/confirm`, {
        method: "POST",
        body: {
          title,
          sharedContext,
          cards: cards.map((card) => ({
            ...card.extra,
            title: card.title.trim(),
            goal: card.goal.trim(),
            context: card.context.trim(),
            acceptanceCriteria: lines(card.criteria),
          })),
        },
      });
      props.onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "确认失败");
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    await api(`/api/splits/${props.split.id}/discard`, { method: "POST" });
    props.onChanged();
  }

  return (
    <Card size="sm" className="ring-amber-500/60">
      <CardHeader>
        <CardTitle>待确认的拆卡</CardTitle>
        <CardDescription>检查并修改下面的卡片，确认后按顺序追加到队尾。</CardDescription>
        <CardAction className="text-xs text-muted-foreground">{cards.length} 张</CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor={`title-${props.split.id}`}>大功能名称</Label>
          <Input id={`title-${props.split.id}`} value={title} onChange={(event) => setTitle(event.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`shared-${props.split.id}`}>整体背景</Label>
          <Textarea
            id={`shared-${props.split.id}`}
            value={sharedContext}
            onChange={(event) => setSharedContext(event.target.value)}
          />
        </div>
        {cards.map((card, index) => (
          <fieldset key={index} className="flex min-w-0 flex-col gap-2 rounded-lg border p-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-xs text-muted-foreground">#{index + 1}</span>
              <Input aria-label="卡片标题" value={card.title} onChange={(event) => update(index, { title: event.target.value })} />
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="删除卡片"
                onClick={() => setCards((current) => current.filter((_, i) => i !== index))}
              >
                <Trash2 />
              </Button>
            </div>
            <Textarea aria-label="目标" placeholder="目标" value={card.goal} onChange={(event) => update(index, { goal: event.target.value })} />
            <Textarea
              aria-label="背景"
              placeholder="背景"
              value={card.context}
              onChange={(event) => update(index, { context: event.target.value })}
            />
            <Textarea
              aria-label="验收标准"
              placeholder="验收标准，每行一条"
              value={card.criteria}
              onChange={(event) => update(index, { criteria: event.target.value })}
            />
          </fieldset>
        ))}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </CardContent>
      <CardFooter className="gap-2">
        <Button type="button" size="sm" disabled={busy || cards.length === 0} onClick={() => void confirm()}>
          确认追加
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void discard()}>
          放弃
        </Button>
      </CardFooter>
    </Card>
  );
}

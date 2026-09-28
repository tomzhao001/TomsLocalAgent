import { Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, rejectLimits, stepLabels, type Feature, type InputAction, type Requirement, type StepId } from "@/lib/api";
import { RequirementFlow } from "./RequirementFlow";
import { StepLogPanel } from "./StepLogPanel";

const statusLabels: Record<Requirement["status"], string> = {
  pending: "排队中",
  running: "进行中",
  waiting_input: "等待输入",
  delivered: "已交付",
  aborted: "已终止",
};

const statusVariants: Record<Requirement["status"], "default" | "secondary" | "outline" | "destructive"> = {
  pending: "outline",
  running: "default",
  waiting_input: "destructive",
  delivered: "secondary",
  aborted: "outline",
};

type Group = { key: string; title: string; progress?: string; items: Requirement[] };

export function groupRequirements(items: Requirement[], features: Feature[]): Group[] {
  const byId = new Map(features.map((feature) => [feature.id, feature]));
  const groups: Group[] = [];
  for (const item of items) {
    const key = item.featureId ?? "manual";
    let group = groups.find((entry) => entry.key === key);
    if (!group) {
      const feature = item.featureId ? byId.get(item.featureId) : undefined;
      group = {
        key,
        title: feature?.title ?? "手动添加",
        progress: feature ? `${feature.delivered}/${feature.total}` : undefined,
        items: [],
      };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

export function RequirementList(props: {
  items: Requirement[];
  features: Feature[];
  readOnly?: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<string[]>([]);
  const autoOpened = useRef(new Set<string>());

  useEffect(() => {
    const fresh = props.items.filter((item) => item.status === "waiting_input" && !autoOpened.current.has(item.id));
    if (fresh.length === 0) return;
    for (const item of fresh) autoOpened.current.add(item.id);
    setOpen((current) => [...new Set([...current, ...fresh.map((item) => item.id)])]);
  }, [props.items]);

  if (props.items.length === 0) return null;

  return (
    <div className="flex flex-col gap-4">
      {groupRequirements(props.items, props.features).map((group) => (
        <section key={group.key} className="flex flex-col gap-1">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            {group.title}
            {group.progress ? <span className="text-xs text-muted-foreground">已交付 {group.progress}</span> : null}
          </h3>
          <Accordion type="multiple" value={open} onValueChange={setOpen} className="rounded-lg border px-3">
            {group.items.map((item) => (
              <AccordionItem key={item.id} value={item.id}>
                <AccordionTrigger>
                  <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    <span className="truncate">{item.card.title}</span>
                    <Badge variant={statusVariants[item.status]}>{statusLabels[item.status]}</Badge>
                    <RequirementMeta item={item} />
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  {open.includes(item.id) ? (
                    <RequirementDetail item={item} readOnly={props.readOnly} onChanged={props.onChanged} />
                  ) : null}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </section>
      ))}
    </div>
  );
}

function RequirementMeta({ item }: { item: Requirement }) {
  const parts: string[] = [];
  if (item.status === "running" && item.phase && item.phase in stepLabels) parts.push(stepLabels[item.phase as StepId]);
  if (item.status === "waiting_input" && item.wait) parts.push(`${stepLabels[item.wait.fromStep]}卡住`);
  if (item.reviewRejects > 0) parts.push(`Review 打回 ${item.reviewRejects}/${rejectLimits.review}`);
  if (parts.length === 0) return null;
  return <span className="text-xs font-normal text-muted-foreground">{parts.join(" · ")}</span>;
}

function RequirementDetail(props: { item: Requirement; readOnly?: boolean; onChanged: () => void }) {
  const [detail, setDetail] = useState<Requirement>(props.item);
  const [selected, setSelected] = useState<StepId | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (props.readOnly) {
      void api<Requirement>(`/api/requirements/${props.item.id}`)
        .then(setDetail)
        .catch(() => setError("详情读取失败"));
    } else {
      setDetail(props.item);
    }
  }, [props.item, props.readOnly]);

  async function submitInput(action: InputAction, text: string) {
    const updated = await api<Requirement>(`/api/requirements/${detail.id}/input`, { method: "POST", body: { action, text } });
    setDetail(updated);
    props.onChanged();
  }

  async function remove() {
    setError("");
    try {
      await api(`/api/requirements/${detail.id}`, { method: "DELETE" });
      props.onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除失败");
    }
  }

  const { card } = detail;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-1 text-xs">
        <p>
          <span className="text-muted-foreground">目标：</span>
          {card.goal}
        </p>
        <p className="whitespace-pre-wrap">
          <span className="text-muted-foreground">背景：</span>
          {card.context}
        </p>
        <div>
          <span className="text-muted-foreground">验收标准：</span>
          <ol className="list-decimal pl-5">
            {card.acceptanceCriteria.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ol>
        </div>
      </div>
      {detail.status === "pending" && !props.readOnly ? (
        <div>
          <Button type="button" size="xs" variant="ghost" onClick={() => void remove()}>
            <Trash2 data-icon="inline-start" />
            删除这张卡
          </Button>
        </div>
      ) : null}
      {detail.status !== "pending" ? (
        <RequirementFlow
          requirement={detail}
          selected={selected}
          onSelect={setSelected}
          onInput={props.readOnly ? undefined : submitInput}
        />
      ) : null}
      {selected ? <StepLogPanel step={selected} runs={detail.steps.filter((run) => run.step === selected)} /> : null}
      {detail.status !== "pending" && !selected ? <p className="text-xs text-muted-foreground">点击节点查看这一步的日志</p> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

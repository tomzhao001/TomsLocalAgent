import { useLayoutEffect, useRef, useState } from "react";
import { Handle, Position, ReactFlow, type BuiltInEdge, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { rejectLimits, stepLabels, workflowSteps, type Requirement, type StepId } from "@/lib/api";

export type StepState = "idle" | "queued" | "running" | "passed" | "rejected" | "error" | "waiting";

const stateLabels: Record<StepState, string> = {
  idle: "未开始",
  queued: "等待调度",
  running: "运行中",
  passed: "通过",
  rejected: "打回",
  error: "出错",
  waiting: "等待输入",
};

const stateClasses: Record<StepState, string> = {
  idle: "border-border bg-background text-muted-foreground",
  queued: "border-sky-400 bg-sky-50",
  running: "border-emerald-500 bg-emerald-50 animate-pulse",
  passed: "border-emerald-500/60 bg-background",
  rejected: "border-orange-400 bg-orange-50",
  error: "border-destructive bg-destructive/5",
  waiting: "border-amber-500 bg-amber-50",
};

export function stepState(requirement: Requirement, step: StepId): StepState {
  if (requirement.status === "waiting_input" && requirement.wait?.fromStep === step) return "waiting";
  const runs = requirement.steps.filter((run) => run.step === step);
  const last = runs.at(-1);
  if (last?.status === "running") return "running";
  if (requirement.status === "running" && requirement.phase === step) return "queued";
  if (!last) return "idle";
  if (last.status !== "finished") return "error";
  if (last.result?.verdict === "reject") return "rejected";
  return "passed";
}

type StepNodeData = {
  step: StepId;
  state: StepState;
  attempts: number;
  selected: boolean;
};

type StepFlowNode = Node<StepNodeData, "step">;

function StepNode({ data }: NodeProps<StepFlowNode>) {
  return (
    <div
      className={`w-64 cursor-pointer rounded-lg border-2 px-3 py-2 text-sm ${stateClasses[data.state]} ${data.selected ? "ring-2 ring-ring/50" : ""}`}
    >
      <Handle type="target" position={Position.Top} id="top" className="opacity-0" />
      <Handle type="target" position={Position.Right} id="right-in" className="opacity-0" />
      <Handle type="source" position={Position.Right} id="right-out" style={{ top: "70%" }} className="opacity-0" />
      <div className="flex items-center justify-between gap-2">
        <strong>{stepLabels[data.step]}</strong>
        <span className="text-xs">
          {stateLabels[data.state]}
          {data.attempts > 0 ? ` · ${data.attempts} 轮` : ""}
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} id="bottom" className="opacity-0" />
    </div>
  );
}

const nodeTypes = { step: StepNode };

const baseHeight = 56;
const gap = 44;
const nodeWidth = 256;
const loopExtra = 88 + 96;
const zoomCap = 0.92;

function fitZoom(available: number, loop: boolean): number {
  if (!available) return zoomCap;
  const contentWidth = nodeWidth + (loop ? loopExtra : 16);
  return Math.min(zoomCap, available / contentWidth);
}

export function RequirementFlow(props: {
  requirement: Requirement;
  selected: StepId | null;
  onSelect: (step: StepId) => void;
}) {
  const { requirement } = props;
  const frame = useRef<HTMLDivElement>(null);
  const loop = requirement.workflowId !== "cursor-qa";
  const [zoom, setZoom] = useState(zoomCap);
  const steps = workflowSteps[requirement.workflowId] ?? workflowSteps["cursor-dev-loop"];
  let y = 0;
  const nodes: StepFlowNode[] = steps.map((step) => {
    const state = stepState(requirement, step);
    const node: StepFlowNode = {
      id: step,
      type: "step",
      position: { x: 0, y },
      data: {
        step,
        state,
        attempts: requirement.steps.filter((run) => run.step === step).length,
        selected: props.selected === step,
      },
    };
    y += baseHeight + gap;
    return node;
  });

  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    let width = 0;
    const apply = () => {
      const nextWidth = el.clientWidth;
      if (!nextWidth || (width && Math.abs(nextWidth - width) < 24)) return;
      width = nextWidth;
      setZoom(Number(fitZoom(nextWidth, loop).toFixed(3)));
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, [loop]);

  const overReview = requirement.reviewRejects > rejectLimits.review;
  const edges: (Edge | BuiltInEdge)[] =
    requirement.workflowId === "cursor-qa"
      ? []
      : [
          { id: "p-d", source: "plan", target: "develop", sourceHandle: "bottom", targetHandle: "top" },
          { id: "d-r", source: "develop", target: "review", sourceHandle: "bottom", targetHandle: "top" },
          { id: "r-o", source: "review", target: "devops", sourceHandle: "bottom", targetHandle: "top" },
          {
            id: "r-p",
            type: "smoothstep",
            pathOptions: { offset: 88, borderRadius: 8 },
            source: "review",
            target: "plan",
            sourceHandle: "right-out",
            targetHandle: "right-in",
            label: `Review 打回 ${requirement.reviewRejects}/${rejectLimits.review}`,
            style: { strokeDasharray: "4 4", stroke: overReview ? "#dc2626" : undefined },
            labelStyle: { fill: overReview ? "#dc2626" : undefined },
          },
        ];

  return (
    <div ref={frame} className="w-full" style={{ height: (y + 24) * zoom }}>
      <ReactFlow
        key={`${y}-${zoom}`}
        colorMode="light"
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        defaultViewport={{ x: 0, y: 0, zoom }}
        minZoom={zoom}
        maxZoom={zoom}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        panOnScroll={false}
        preventScrolling={false}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, node) => props.onSelect(node.id as StepId)}
      />
    </div>
  );
}

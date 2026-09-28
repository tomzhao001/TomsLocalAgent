import { Handle, Position, ReactFlow, type BuiltInEdge, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { rejectLimits, stepIds, stepLabels, type InputAction, type Requirement, type StepId, type WaitInfo } from "@/lib/api";
import { WaitForm } from "./WaitForm";

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
  wait: WaitInfo | null;
  onInput?: (action: InputAction, text: string) => Promise<void>;
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
      {data.state === "waiting" && data.wait && data.onInput ? (
        <div className="mt-2" onClick={(event) => event.stopPropagation()}>
          <WaitForm wait={data.wait} onSubmit={data.onInput} />
        </div>
      ) : null}
      <Handle type="source" position={Position.Bottom} id="bottom" className="opacity-0" />
    </div>
  );
}

const nodeTypes = { step: StepNode };

const baseHeight = 56;
const gap = 44;
const waitHeight = 240;

export function RequirementFlow(props: {
  requirement: Requirement;
  selected: StepId | null;
  onSelect: (step: StepId) => void;
  onInput?: (action: InputAction, text: string) => Promise<void>;
}) {
  const { requirement } = props;
  let y = 0;
  const nodes: StepFlowNode[] = stepIds.map((step) => {
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
        wait: requirement.wait,
        onInput: props.onInput,
      },
    };
    y += baseHeight + gap + (state === "waiting" && props.onInput ? waitHeight : 0);
    return node;
  });
  const overArch = requirement.archRejects > rejectLimits.arch;
  const overQa = requirement.qaRejects > rejectLimits.qa;
  const edges: (Edge | BuiltInEdge)[] = [
    { id: "d-a", source: "develop", target: "arch", sourceHandle: "bottom", targetHandle: "top" },
    { id: "a-q", source: "arch", target: "qa", sourceHandle: "bottom", targetHandle: "top" },
    { id: "q-o", source: "qa", target: "devops", sourceHandle: "bottom", targetHandle: "top" },
    {
      id: "a-d",
      type: "smoothstep",
      pathOptions: { offset: 24, borderRadius: 8 },
      source: "arch",
      target: "develop",
      sourceHandle: "right-out",
      targetHandle: "right-in",
      label: `架构打回 ${requirement.archRejects}/${rejectLimits.arch}`,
      style: { strokeDasharray: "4 4", stroke: overArch ? "#dc2626" : undefined },
      labelStyle: { fill: overArch ? "#dc2626" : undefined },
    },
    {
      id: "q-d",
      type: "smoothstep",
      pathOptions: { offset: 72, borderRadius: 8 },
      source: "qa",
      target: "develop",
      sourceHandle: "right-out",
      targetHandle: "right-in",
      label: `QA 打回 ${requirement.qaRejects}/${rejectLimits.qa}`,
      style: { strokeDasharray: "4 4", stroke: overQa ? "#dc2626" : undefined },
      labelStyle: { fill: overQa ? "#dc2626" : undefined },
    },
  ];

  return (
    <div className="w-full" style={{ height: y + 24 }}>
      <ReactFlow
        key={y}
        colorMode="light"
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.08, maxZoom: 1 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnScroll={false}
        panOnScroll={false}
        preventScrolling={false}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, node) => props.onSelect(node.id as StepId)}
      />
    </div>
  );
}

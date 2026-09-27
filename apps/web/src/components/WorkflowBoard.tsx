import { ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

const labels: Record<string, string> = {
  develop: "开发",
  arch: "架构审核",
  qa: "QA",
  devops: "DevOps",
};

export function WorkflowBoard(props: {
  status: string;
  phase?: string;
  archRejects?: number;
  qaRejects?: number;
  holder?: string;
  onContinue?: (text: string) => void;
}) {
  const nodes = ["develop", "arch", "qa", "devops"].map((id, index) => ({
    id,
    position: { x: 40, y: index * 90 },
    data: { label: `${labels[id]}${props.phase === id ? " · 进行中" : ""}` },
  }));
  const edges = [
    { id: "d-a", source: "develop", target: "arch" },
    { id: "a-q", source: "arch", target: "qa" },
    { id: "q-o", source: "qa", target: "devops" },
    { id: "a-d", source: "arch", target: "develop", label: `${props.archRejects ?? 0}/3` },
    { id: "q-d", source: "qa", target: "develop", label: `${props.qaRejects ?? 0}/2` },
  ];

  return (
    <section>
      {props.holder ? <p role="status">占用中：{props.holder}</p> : null}
      <div style={{ height: 420 }}>
        <ReactFlow nodes={nodes} edges={edges} fitView />
      </div>
      {props.status === "waiting_input" ? (
        <form
          role="alert"
          onSubmit={(event) => {
            event.preventDefault();
            const text = String(new FormData(event.currentTarget).get("note") ?? "");
            props.onContinue?.(text);
          }}
        >
          <p>流程暂停，等待你的输入</p>
          <input name="note" aria-label="继续说明" />
          <button type="submit">继续修改</button>
        </form>
      ) : null}
    </section>
  );
}

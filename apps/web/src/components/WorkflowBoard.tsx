import { ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

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
    <section className="flex flex-col gap-3">
      {props.holder ? (
        <Badge variant="secondary" role="status">
          占用中：{props.holder}
        </Badge>
      ) : null}
      <Card>
        <CardContent>
          <div className="h-[420px]">
            <ReactFlow colorMode="light" nodes={nodes} edges={edges} fitView />
          </div>
        </CardContent>
      </Card>
      {props.status === "waiting_input" ? (
        <Alert>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const text = String(new FormData(event.currentTarget).get("note") ?? "");
              props.onContinue?.(text);
            }}
          >
            <AlertTitle>流程暂停，等待你的输入</AlertTitle>
            <div className="flex gap-2">
              <Input name="note" aria-label="继续说明" />
              <Button type="submit">继续修改</Button>
            </div>
          </form>
        </Alert>
      ) : null}
    </section>
  );
}

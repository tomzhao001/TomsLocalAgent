import { useState, type FormEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";

export function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function RequirementDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  onCreated: () => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setError("");
    setBusy(true);
    try {
      await api(`/api/workspaces/${props.workspaceId}/requirements`, {
        method: "POST",
        body: {
          title: String(data.get("title") ?? "").trim(),
          goal: String(data.get("goal") ?? "").trim(),
          context: String(data.get("context") ?? "").trim(),
          acceptanceCriteria: lines(String(data.get("criteria") ?? "")),
          workflow: String(data.get("workflow") ?? "cursor-dev-loop"),
        },
      });
      form.reset();
      props.onOpenChange(false);
      props.onCreated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "新增失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>新增需求</DialogTitle>
            <DialogDescription>这张卡会追加到队尾。开发循环会先写计划再开发、审核和推送；QA 只跑端到端测试。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="req-workflow">工作流</Label>
            <select
              id="req-workflow"
              name="workflow"
              defaultValue="cursor-dev-loop"
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
            >
              <option value="cursor-dev-loop">开发循环</option>
              <option value="cursor-qa">QA（E2E）</option>
            </select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="req-title">标题</Label>
            <Input id="req-title" name="title" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="req-goal">目标</Label>
            <Textarea id="req-goal" name="goal" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="req-context">背景</Label>
            <Textarea id="req-context" name="context" placeholder="已做的决定、约束、相关文件" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="req-criteria">验收标准（每行一条）</Label>
            <Textarea id="req-criteria" name="criteria" required />
          </div>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={busy}>
              追加到队尾
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

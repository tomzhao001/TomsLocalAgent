import { useState, type FormEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";

export function SplitDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  chatSessionId?: string;
  onStarted: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api(`/api/workspaces/${props.workspaceId}/splits`, {
        method: "POST",
        body: { prompt, chatSessionId: props.chatSessionId },
      });
      setPrompt("");
      props.onOpenChange(false);
      props.onStarted();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "拆卡失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>{props.chatSessionId ? "把这段聊天转为工作流" : "拆卡"}</DialogTitle>
            <DialogDescription>
              拆卡由一个单独的只读 agent 完成，不会修改代码。
              {props.chatSessionId ? "这段聊天的记录会作为背景一起交给它。" : ""}
              拆完后在工作流页确认，确认后的卡片会追加到队尾。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="split-prompt">拆卡要求</Label>
            <Textarea
              id="split-prompt"
              value={prompt}
              placeholder="例如：只做后端部分，拆成不超过 5 张卡"
              onChange={(event) => setPrompt(event.target.value)}
              required
            />
          </div>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={busy || !prompt.trim()}>
              开始拆卡
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

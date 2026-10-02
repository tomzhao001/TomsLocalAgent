import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { matchVariant, parameterValues, type ModelInfo, type ModelParam } from "@/pages/model-choice";

export function ModelDialog({
  open,
  models,
  draftId,
  draftParams,
  title = "模型",
  onOpenChange,
  onModel,
  onParams,
  onApply,
}: {
  open: boolean;
  models: ModelInfo[];
  draftId: string;
  draftParams: ModelParam[];
  title?: string;
  onOpenChange: (open: boolean) => void;
  onModel: (id: string) => void;
  onParams: (params: ModelParam[]) => void;
  onApply: () => void;
}) {
  const selected = models.find((item) => item.id === draftId);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-2">
            <Label>模型</Label>
            <Select value={draftId} onValueChange={(value) => { if (value) onModel(value); }}>
              <SelectTrigger aria-label="选择模型">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {models.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {(selected?.parameters ?? []).map((param) => (
            <div key={param.id} className="grid gap-2">
              <Label>{param.label}</Label>
              <Select
                value={draftParams.find((item) => item.id === param.id)?.value ?? ""}
                onValueChange={(value) => {
                  if (!value || !selected) return;
                  onParams(matchVariant(selected, draftParams, { id: param.id, value }));
                }}
              >
                <SelectTrigger aria-label={param.label}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {parameterValues(selected, param).map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="button" onClick={onApply}>
            确定
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

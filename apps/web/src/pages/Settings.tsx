import { Loader2, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { ModelDialog } from "@/components/ModelDialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  canonicalStoredModel,
  defaultModelParams,
  formatVariantId,
  modelSummary,
  parseVariantId,
  type ModelInfo,
  type ModelParam,
} from "./model-choice";

type Workspace = {
  id: string;
  name: string;
  path: string;
  repos: string[];
  archived: boolean;
  chatModel?: string;
  developModel?: string;
  reviewModel?: string;
  cursorSettingSources?: CursorLayer[];
};

const cursorLayers = [
  { id: "project", label: "这个仓库的 .cursor/（含 mcp.json）" },
  { id: "user", label: "本机 ~/.cursor/ 里的用户级 skills 和配置" },
  { id: "plugins", label: "本机已安装的 Cursor plugins" },
] as const;

type CursorLayer = (typeof cursorLayers)[number]["id"];

export function SettingsPage({ onChanged }: { onChanged?: () => void }) {
  const [items, setItems] = useState<Workspace[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [browsing, setBrowsing] = useState(false);

  async function load() {
    const res = await fetch("/api/workspaces", { credentials: "include" });
    if (!res.ok) return;
    setItems((await res.json()) as Workspace[]);
  }

  async function reload() {
    await load();
    onChanged?.();
  }

  useEffect(() => {
    let cancelled = false;
    void load();
    setModelsLoading(true);
    void fetch("/api/providers/cursor/models", { credentials: "include" })
      .then(async (res) => {
        const body = (await res.json().catch(() => [])) as ModelInfo[];
        if (!cancelled && res.ok && Array.isArray(body)) setModels(body);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function browse() {
    setError("");
    setBrowsing(true);
    try {
      const res = await fetch("/api/workspaces/browse", { method: "POST", credentials: "include" });
      const body = (await res.json().catch(() => ({}))) as { path?: string | null; message?: string };
      if (!res.ok) {
        setError(body.message ?? "无法打开目录选择");
        return;
      }
      if (body.path) setPath(body.path);
    } finally {
      setBrowsing(false);
    }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const data = new FormData(event.currentTarget);
    const res = await fetch("/api/workspaces", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: String(data.get("name") ?? ""), path: String(data.get("path") ?? "") }),
    });
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    if (!res.ok) {
      setError(body.message ?? "保存失败");
      return;
    }
    setName("");
    setPath("");
    await reload();
  }

  async function rename(item: Workspace) {
    const next = window.prompt("新名称", item.name);
    if (!next) return;
    const res = await fetch(`/api/workspaces/${item.id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: next }),
    });
    if (!res.ok) {
      const body = (await res.json()) as { message?: string };
      setError(body.message ?? "修改失败");
      return;
    }
    await reload();
  }

  async function remove(item: Workspace) {
    setError("");
    const res = await fetch(`/api/workspaces/${item.id}`, { method: "DELETE", credentials: "include" });
    if (res.status === 409) {
      const body = (await res.json()) as { message?: string };
      setError(body.message ?? "只能归档");
      return;
    }
    await reload();
  }

  async function archive(item: Workspace) {
    setError("");
    const res = await fetch(`/api/workspaces/${item.id}/archive`, { method: "POST", credentials: "include" });
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    if (!res.ok) {
      setError(body.message ?? "归档失败");
      return;
    }
    await reload();
  }

  async function scan(item: Workspace) {
    await fetch(`/api/workspaces/${item.id}/scan`, { method: "POST", credentials: "include" });
    await reload();
  }

  return (
    <section className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Workspace</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={(event) => void create(event)}>
            <div className="grid gap-2">
              <Label htmlFor="workspace-name">名称</Label>
              <Input id="workspace-name" name="name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="workspace-path">路径</Label>
              <div className="flex gap-2">
                <Input
                  id="workspace-path"
                  name="path"
                  className="min-w-0 flex-1"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="本机任意已有目录"
                  required
                />
                <Button type="button" variant="outline" disabled={browsing} onClick={() => void browse()}>
                  {browsing ? "选择中" : "浏览"}
                </Button>
              </div>
            </div>
            <Button type="submit">添加</Button>
          </form>
        </CardContent>
      </Card>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-3">
        {items.map((item) => (
          <Card key={item.id} size="sm">
            <CardHeader>
              <CardTitle>
                {item.name}
                {item.archived ? "（已归档）" : ""}
              </CardTitle>
              <CardDescription>{item.path}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-muted-foreground">仓库：{item.repos.length === 0 ? "无" : item.repos.join("，")}</p>
              <ModelFields item={item} models={models} modelsLoading={modelsLoading} onError={setError} onSaved={() => void reload()} />
            </CardContent>
            <CardFooter className="gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => void rename(item)}>
                改名
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => void scan(item)}>
                重新扫描
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => void archive(item)}>
                归档
              </Button>
              <Button type="button" size="sm" variant="destructive" onClick={() => void remove(item)}>
                删除
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>
    </section>
  );
}

function ModelFields({
  item,
  models,
  modelsLoading,
  onError,
  onSaved,
}: {
  item: Workspace;
  models: ModelInfo[];
  modelsLoading: boolean;
  onError: (message: string) => void;
  onSaved: () => void;
}) {
  const [chatModel, setChatModel] = useState(item.chatModel ?? "");
  const [developModel, setDevelopModel] = useState(item.developModel ?? "");
  const [reviewModel, setReviewModel] = useState(item.reviewModel ?? "");
  const [sources, setSources] = useState<CursorLayer[]>(item.cursorSettingSources ?? []);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setChatModel(canonicalStoredModel(models, item.chatModel ?? ""));
    setDevelopModel(canonicalStoredModel(models, item.developModel ?? ""));
    setReviewModel(canonicalStoredModel(models, item.reviewModel ?? ""));
    setSources(item.cursorSettingSources ?? []);
  }, [item.chatModel, item.developModel, item.reviewModel, item.cursorSettingSources, models]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    onError("");
    const res = await fetch(`/api/workspaces/${item.id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatModel, developModel, reviewModel, cursorSettingSources: sources }),
    });
    setSaving(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      onError(body.message ?? "模型保存失败");
      return;
    }
    onSaved();
  }

  return (
    <form className="grid gap-3 sm:grid-cols-3" onSubmit={(event) => void save(event)}>
      <ModelField label="聊天默认模型" value={chatModel} models={models} loading={modelsLoading} onChange={setChatModel} />
      <ModelField label="工作流开发默认模型" value={developModel} models={models} loading={modelsLoading} onChange={setDevelopModel} />
      <div className="grid gap-2 sm:col-span-2 sm:grid-cols-[1fr_auto] sm:items-end">
        <ModelField label="工作流 Review 默认模型" value={reviewModel} models={models} loading={modelsLoading} onChange={setReviewModel} />
        <Button type="submit" size="sm" variant="outline" disabled={saving}>
          {saving ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
          保存模型
        </Button>
      </div>
      <fieldset className="grid gap-2 sm:col-span-3">
        <legend className="text-sm font-medium">Cursor 配置层</legend>
        {cursorLayers.map((layer) => (
          <label key={layer.id} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={sources.includes(layer.id)}
              onChange={(event) => {
                setSources((current) =>
                  event.target.checked ? [...current, layer.id] : current.filter((item) => item !== layer.id),
                );
              }}
            />
            <span>{layer.label}</span>
          </label>
        ))}
      </fieldset>
    </form>
  );
}

function ModelField({
  label,
  value,
  models,
  loading,
  onChange,
}: {
  label: string;
  value: string;
  models: ModelInfo[];
  loading: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draftId, setDraftId] = useState("");
  const [draftParams, setDraftParams] = useState<ModelParam[]>([]);
  const parsed = parseVariantId(value);
  const selected = models.find((item) => item.id === parsed.id);
  const summary = value
    ? modelSummary(selected, parsed.params.length ? parsed.params : defaultModelParams(selected))
    : "沿用环境变量";

  function openDialog() {
    const model = selected ?? models[0];
    if (!model) return;
    setDraftId(model.id);
    setDraftParams(parsed.id === model.id && parsed.params.length ? parsed.params : defaultModelParams(model));
    setOpen(true);
  }

  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      <div className="flex gap-1">
        <Button
          type="button"
          variant="outline"
          className="min-w-0 flex-1 justify-start"
          aria-label={label}
          disabled={loading || models.length === 0}
          onClick={openDialog}
        >
          {loading ? (
            <>
              <Loader2 className="animate-spin" data-icon="inline-start" />
              加载模型…
            </>
          ) : (
            <span className="truncate">{!value || selected ? summary : parsed.id}</span>
          )}
        </Button>
        <Button type="button" size="icon" variant="ghost" aria-label={`清空${label}`} disabled={!value} onClick={() => onChange("")}>
          <X />
        </Button>
      </div>
      <ModelDialog
        open={open}
        models={models}
        draftId={draftId}
        draftParams={draftParams}
        title={label}
        onOpenChange={setOpen}
        onModel={(id) => {
          setDraftId(id);
          setDraftParams(defaultModelParams(models.find((item) => item.id === id)));
        }}
        onParams={setDraftParams}
        onApply={() => {
          onChange(formatVariantId(draftId, draftParams));
          setOpen(false);
        }}
      />
    </div>
  );
}

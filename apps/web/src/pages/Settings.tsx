import { ChevronDown } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Workspace = {
  id: string;
  name: string;
  path: string;
  repos: string[];
  archived: boolean;
  chatModel?: string;
  developModel?: string;
  reviewModel?: string;
};

type ModelInfo = { id: string; label: string };

export function SettingsPage({ onChanged }: { onChanged?: () => void }) {
  const [items, setItems] = useState<Workspace[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
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
    void load();
    void fetch("/api/providers/cursor/models", { credentials: "include" })
      .then(async (res) => {
        const body = (await res.json().catch(() => [])) as ModelInfo[];
        if (res.ok && Array.isArray(body)) setModels(body);
      })
      .catch(() => {});
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
              <ModelFields item={item} models={models} onError={setError} onSaved={() => void reload()} />
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
  onError,
  onSaved,
}: {
  item: Workspace;
  models: ModelInfo[];
  onError: (message: string) => void;
  onSaved: () => void;
}) {
  const [chatModel, setChatModel] = useState(item.chatModel ?? "");
  const [developModel, setDevelopModel] = useState(item.developModel ?? "");
  const [reviewModel, setReviewModel] = useState(item.reviewModel ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setChatModel(item.chatModel ?? "");
    setDevelopModel(item.developModel ?? "");
    setReviewModel(item.reviewModel ?? "");
  }, [item.chatModel, item.developModel, item.reviewModel]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    onError("");
    const res = await fetch(`/api/workspaces/${item.id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatModel, developModel, reviewModel }),
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
      <ModelSelect id={`${item.id}-chat-model`} label="聊天默认模型" value={chatModel} models={models} onChange={setChatModel} />
      <ModelSelect
        id={`${item.id}-develop-model`}
        label="工作流开发默认模型"
        value={developModel}
        models={models}
        onChange={setDevelopModel}
      />
      <div className="grid gap-2 sm:col-span-2 sm:grid-cols-[1fr_auto] sm:items-end">
        <ModelSelect
          id={`${item.id}-review-model`}
          label="工作流 Review 默认模型"
          value={reviewModel}
          models={models}
          onChange={setReviewModel}
        />
        <Button type="submit" size="sm" variant="outline" disabled={saving}>
          保存模型
        </Button>
      </div>
    </form>
  );
}

function ModelSelect({
  id,
  label,
  value,
  models,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  models: ModelInfo[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative flex gap-1">
        <Input
          id={id}
          className="min-w-0 flex-1"
          value={value}
          placeholder="留空则沿用环境变量"
          onChange={(event) => onChange(event.target.value)}
        />
        <Button
          type="button"
          size="icon"
          variant="outline"
          aria-label={`${label}候选`}
          aria-expanded={open}
          disabled={models.length === 0}
          onClick={() => setOpen((current) => !current)}
        >
          <ChevronDown />
        </Button>
        {open ? (
          <ul className="absolute top-full right-0 z-20 mt-1 max-h-48 w-full overflow-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
            {models.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                  onClick={() => {
                    onChange(item.id);
                    setOpen(false);
                  }}
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

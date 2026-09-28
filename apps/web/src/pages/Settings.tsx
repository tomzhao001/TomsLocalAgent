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
};

export function SettingsPage({ onChanged }: { onChanged?: () => void }) {
  const [items, setItems] = useState<Workspace[]>([]);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [error, setError] = useState("");

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
  }, []);

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
              <Input id="workspace-path" name="path" value={path} onChange={(e) => setPath(e.target.value)} required />
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
            <CardContent>
              <p className="text-muted-foreground">仓库：{item.repos.length === 0 ? "无" : item.repos.join("，")}</p>
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

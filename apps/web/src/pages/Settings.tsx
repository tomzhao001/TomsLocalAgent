import { useEffect, useState, type FormEvent } from "react";

type Workspace = {
  id: string;
  name: string;
  path: string;
  repos: string[];
  archived: boolean;
};

export function SettingsPage() {
  const [items, setItems] = useState<Workspace[]>([]);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [error, setError] = useState("");

  async function reload() {
    const res = await fetch("/api/workspaces", { credentials: "include" });
    if (!res.ok) return;
    setItems((await res.json()) as Workspace[]);
  }

  useEffect(() => {
    void reload();
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
    <section>
      <h2>Workspace</h2>
      <form onSubmit={(event) => void create(event)}>
        <label>
          名称
          <input name="name" value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          路径
          <input name="path" value={path} onChange={(e) => setPath(e.target.value)} required />
        </label>
        <button type="submit">添加</button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <strong>{item.name}</strong>
            {item.archived ? "（已归档）" : ""}
            <div>{item.path}</div>
            <div>仓库：{item.repos.length === 0 ? "无" : item.repos.join("，")}</div>
            <button type="button" onClick={() => void rename(item)}>
              改名
            </button>
            <button type="button" onClick={() => void scan(item)}>
              重新扫描
            </button>
            <button type="button" onClick={() => void archive(item)}>
              归档
            </button>
            <button type="button" onClick={() => void remove(item)}>
              删除
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

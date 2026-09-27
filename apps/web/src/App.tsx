import { useEffect, useState } from "react";
import { LoginPage } from "./pages/Login";
import { SettingsPage } from "./pages/Settings";

export function App() {
  const [username, setUsername] = useState<string | null | undefined>(undefined);
  const [page, setPage] = useState<"home" | "settings">("settings");

  async function refresh() {
    const res = await fetch("/api/me", { credentials: "include" });
    setUsername(res.ok ? ((await res.json()) as { username: string }).username : null);
  }

  useEffect(() => {
    void refresh();
  }, []);

  if (username === undefined) return <p>加载中…</p>;
  if (!username) return <LoginPage onLoggedIn={(name) => setUsername(name)} />;

  return (
    <main style={{ maxWidth: 720, margin: "2rem auto", fontFamily: "sans-serif" }}>
      <header style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <strong>AI Gateway</strong>
        <button type="button" onClick={() => setPage("settings")}>
          设置
        </button>
        <span style={{ marginLeft: "auto" }}>{username}</span>
        <button
          type="button"
          onClick={() => {
            void fetch("/api/logout", { method: "POST", credentials: "include" }).then(() => setUsername(null));
          }}
        >
          退出
        </button>
      </header>
      {page === "settings" ? <SettingsPage /> : <p>聊天将在后续里程碑接入。</p>}
    </main>
  );
}

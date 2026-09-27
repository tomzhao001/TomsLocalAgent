import { useEffect, useState, type FormEvent } from "react";

export function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [username, setUsername] = useState<string | null>(null);

  async function refreshMe() {
    const res = await fetch("/api/me", { credentials: "include" });
    if (!res.ok) {
      setUsername(null);
      return;
    }
    const body = (await res.json()) as { username: string };
    setUsername(body.username);
  }

  useEffect(() => {
    void refreshMe();
  }, []);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      setError(res.status === 429 ? "尝试次数过多，请稍后再试" : "密码不正确");
      return;
    }
    await refreshMe();
  }

  async function logout() {
    await fetch("/api/logout", { method: "POST", credentials: "include" });
    setUsername(null);
  }

  if (username) {
    return (
      <main style={{ maxWidth: 360, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>AI Gateway</h1>
        <p>已登录：{username}</p>
        <button type="button" onClick={() => void logout()}>
          退出
        </button>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 360, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>AI Gateway</h1>
      <form onSubmit={(event) => void onSubmit(event)}>
        <label>
          管理员密码
          <input
            type="password"
            name="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            style={{ display: "block", width: "100%", marginTop: 8 }}
          />
        </label>
        <button type="submit" style={{ marginTop: 16 }}>
          登录
        </button>
        {error ? <p role="alert">{error}</p> : null}
      </form>
    </main>
  );
}

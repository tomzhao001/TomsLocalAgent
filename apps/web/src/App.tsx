import { useEffect, useState } from "react";
import { WorkflowBoard } from "./components/WorkflowBoard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ChatPage } from "./pages/Chat";
import { LoginPage } from "./pages/Login";
import { SettingsPage } from "./pages/Settings";

export function App() {
  const [username, setUsername] = useState<string | null | undefined>(undefined);
  const [page, setPage] = useState<"chat" | "settings" | "workflow">("chat");
  const [flowStatus, setFlowStatus] = useState<"running" | "waiting_input">("running");

  async function refresh() {
    const res = await fetch("/api/me", { credentials: "include" });
    setUsername(res.ok ? ((await res.json()) as { username: string }).username : null);
  }

  useEffect(() => {
    void refresh();
  }, []);

  if (username === undefined) return <p className="p-8 text-sm text-muted-foreground">加载中…</p>;
  if (!username) return <LoginPage onLoggedIn={(name) => setUsername(name)} />;

  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <strong className="mr-2 text-sm">AI Gateway</strong>
        <Button type="button" size="sm" variant={page === "chat" ? "default" : "ghost"} onClick={() => setPage("chat")}>
          聊天
        </Button>
        <Button
          type="button"
          size="sm"
          variant={page === "workflow" ? "default" : "ghost"}
          onClick={() => setPage("workflow")}
        >
          工作流
        </Button>
        <Button
          type="button"
          size="sm"
          variant={page === "settings" ? "default" : "ghost"}
          onClick={() => setPage("settings")}
        >
          设置
        </Button>
        <Separator orientation="vertical" className="mx-1 h-5" />
        <Badge variant="secondary" className="ml-auto">
          {username}
        </Badge>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            void fetch("/api/logout", { method: "POST", credentials: "include" }).then(() => setUsername(null));
          }}
        >
          退出
        </Button>
      </header>
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col p-4">
        {page === "settings" ? <SettingsPage /> : null}
        {page === "chat" ? <ChatPage /> : null}
        {page === "workflow" ? (
          <section className="flex flex-col gap-3">
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant={flowStatus === "running" ? "default" : "outline"}
                onClick={() => setFlowStatus("running")}
              >
                运行中
              </Button>
              <Button
                type="button"
                size="sm"
                variant={flowStatus === "waiting_input" ? "default" : "outline"}
                onClick={() => setFlowStatus("waiting_input")}
              >
                等待输入
              </Button>
            </div>
            <WorkflowBoard
              status={flowStatus}
              phase={flowStatus === "running" ? "develop" : "arch"}
              archRejects={flowStatus === "waiting_input" ? 4 : 1}
              qaRejects={0}
              holder={flowStatus === "running" ? "工作流 #12" : undefined}
            />
          </section>
        ) : null}
      </main>
    </div>
  );
}

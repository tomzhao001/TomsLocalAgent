import { ArrowLeft, Settings } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BranchButton, BranchDialog } from "./components/BranchDialog";
import { StatusDot, WorkspaceSwitcher, attentionOf, sortWorkspaces } from "./components/WorkspaceSwitcher";
import { api, type Workspace, type WorkspaceStatus } from "./lib/api";
import { usePolling } from "./lib/usePolling";
import { ChatPage } from "./pages/Chat";
import { LoginPage } from "./pages/Login";
import { SettingsPage } from "./pages/Settings";
import { WorkflowPage } from "./pages/Workflow";

const storageKey = "gateway.workspace";

export function App() {
  const [username, setUsername] = useState<string | null | undefined>(undefined);
  const [page, setPage] = useState<"workspace" | "settings">("workspace");
  const [tab, setTab] = useState<"chat" | "workflow">("chat");
  const [chatToolbar, setChatToolbar] = useState<ReactNode>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [statuses, setStatuses] = useState<WorkspaceStatus[]>([]);
  const [workspaceId, setWorkspaceId] = useState(() => localStorage.getItem(storageKey) ?? "");
  const [branchesOpen, setBranchesOpen] = useState(false);

  async function refresh() {
    const res = await fetch("/api/me", { credentials: "include" });
    setUsername(res.ok ? ((await res.json()) as { username: string }).username : null);
  }

  useEffect(() => {
    void refresh();
  }, []);

  const loadStatuses = useCallback(async () => {
    try {
      setStatuses(await api<WorkspaceStatus[]>("/api/workflow/status"));
    } catch {
      // 下一轮轮询再试
    }
  }, []);

  const loadWorkspaces = useCallback(async () => {
    const items = (await api<Workspace[]>("/api/workspaces")).filter((item) => !item.archived);
    setWorkspaces(items);
    await loadStatuses();
  }, [loadStatuses]);

  useEffect(() => {
    if (username) void loadWorkspaces();
  }, [username, loadWorkspaces]);

  usePolling(loadStatuses, 10_000, Boolean(username));

  useEffect(() => {
    if (!workspaces || workspaces.length === 0) return;
    if (!workspaces.some((item) => item.id === workspaceId)) {
      selectWorkspace(sortWorkspaces(workspaces, statuses)[0]!.id);
    }
  }, [workspaces, workspaceId, statuses]);

  function selectWorkspace(id: string) {
    setWorkspaceId(id);
    localStorage.setItem(storageKey, id);
  }

  if (username === undefined) return <p className="p-8 text-sm text-muted-foreground">加载中…</p>;
  if (!username) return <LoginPage onLoggedIn={(name) => setUsername(name)} />;

  const current = statuses.find((item) => item.workspaceId === workspaceId);
  const needsYou = attentionOf(current) === "waiting";

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <strong className="mr-1 hidden text-sm sm:inline">AI Gateway</strong>
        {page === "settings" ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => setPage("workspace")}>
            <ArrowLeft data-icon="inline-start" />
            返回
          </Button>
        ) : workspaces && workspaces.length > 0 ? (
          <>
            <WorkspaceSwitcher workspaces={workspaces} statuses={statuses} value={workspaceId} onChange={selectWorkspace} />
            {workspaces.some((item) => item.id === workspaceId) ? (
              <BranchButton onClick={() => setBranchesOpen(true)} />
            ) : null}
          </>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            size="icon-sm"
            variant={page === "settings" ? "secondary" : "ghost"}
            aria-label="设置"
            onClick={() => {
              setBranchesOpen(false);
              setPage(page === "settings" ? "workspace" : "settings");
            }}
          >
            <Settings />
          </Button>
          <Badge variant="secondary" className="hidden sm:inline-flex">
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
        </div>
      </header>
      {workspaces?.some((item) => item.id === workspaceId) ? (
        <BranchDialog open={branchesOpen && page === "workspace"} onOpenChange={setBranchesOpen} workspaceId={workspaceId} />
      ) : null}
      <main className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col overflow-y-auto p-4">
        {page === "settings" ? <SettingsPage onChanged={() => void loadWorkspaces()} /> : null}
        {page === "workspace" && workspaces && workspaces.length === 0 ? (
          <Card className="mx-auto w-full max-w-md">
            <CardHeader>
              <CardTitle>还没有 Workspace</CardTitle>
              <CardDescription>先在设置里添加一个本机目录，之后就能在这里聊天和运行工作流。</CardDescription>
            </CardHeader>
            <CardContent>
              <Button type="button" onClick={() => setPage("settings")}>
                去设置
              </Button>
            </CardContent>
          </Card>
        ) : null}
        {page === "workspace" && workspaceId && workspaces?.some((item) => item.id === workspaceId) ? (
          <Tabs value={tab} onValueChange={(value) => setTab(value as "chat" | "workflow")} className="min-h-0 flex-1 overflow-hidden">
            <div className="flex flex-wrap items-center gap-2">
              <TabsList>
                <TabsTrigger value="chat">聊天</TabsTrigger>
                <TabsTrigger value="workflow">
                  工作流
                  <StatusDot attention={needsYou ? "waiting" : "idle"} label="有事项等你处理" />
                </TabsTrigger>
              </TabsList>
              {tab === "chat" ? chatToolbar : null}
            </div>
            <TabsContent value="chat" forceMount className="flex min-h-0 flex-col overflow-hidden data-[state=inactive]:hidden">
              <ChatPage
                key={workspaceId}
                workspaceId={workspaceId}
                chatModel={workspaces?.find((item) => item.id === workspaceId)?.chatModel ?? ""}
                onSplitStarted={() => setTab("workflow")}
                onToolbar={setChatToolbar}
              />
            </TabsContent>
            <TabsContent value="workflow" forceMount className="flex min-h-0 flex-col overflow-y-auto data-[state=inactive]:hidden">
              <WorkflowPage
                key={workspaceId}
                workspaceId={workspaceId}
                active={tab === "workflow"}
                onChanged={() => void loadStatuses()}
              />
            </TabsContent>
          </Tabs>
        ) : null}
      </main>
    </div>
  );
}

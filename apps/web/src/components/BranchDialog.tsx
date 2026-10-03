import { Diff, GitBranch, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiError, api, type GitChange, type GitRepo } from "@/lib/api";

export function BranchDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
}) {
  const [repos, setRepos] = useState<GitRepo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, "switch" | "fetch" | "status">>({});
  const [pending, setPending] = useState<{ path: string; branch: string; name: string } | null>(null);
  const [warnOpen, setWarnOpen] = useState(false);
  const [changes, setChanges] = useState<{ name: string; files: GitChange[]; loading: boolean; error: string } | null>(null);
  const [changesOpen, setChangesOpen] = useState(false);

  useEffect(() => {
    if (!props.open) {
      setWarnOpen(false);
      setChangesOpen(false);
      return;
    }
    let cancel = false;
    setLoading(true);
    setLoadError("");
    setRowError({});
    api<{ repos: GitRepo[] }>(`/api/workspaces/${props.workspaceId}/git`)
      .then((body) => {
        if (!cancel) setRepos(body.repos);
      })
      .catch((reason: unknown) => {
        if (!cancel) setLoadError(reason instanceof Error ? reason.message : "读取分支失败");
      })
      .finally(() => {
        if (!cancel) setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [props.open, props.workspaceId]);

  function replaceRepo(path: string, next: GitRepo) {
    setRepos((current) => current.map((item) => (item.path === path || item.path === next.path ? next : item)));
    setRowError((current) => ({ ...current, [path]: "", [next.path]: "" }));
  }

  async function runSwitch(path: string, branch: string, stash: boolean) {
    setBusy((current) => ({ ...current, [path]: "switch" }));
    setRowError((current) => ({ ...current, [path]: "" }));
    try {
      const next = await api<GitRepo>(`/api/workspaces/${props.workspaceId}/git/switch`, {
        method: "POST",
        body: { path, branch, stash },
      });
      replaceRepo(path, next);
      setWarnOpen(false);
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === "dirty") {
        const repo = repos.find((item) => item.path === path);
        setPending({ path, branch, name: repo?.name ?? path });
        setWarnOpen(true);
        return;
      }
      setRowError((current) => ({ ...current, [path]: reason instanceof Error ? reason.message : "切换失败" }));
      setWarnOpen(false);
    } finally {
      setBusy((current) => {
        const next = { ...current };
        delete next[path];
        return next;
      });
    }
  }

  function pickBranch(repo: GitRepo, value: string) {
    const branch = value.slice(value.indexOf(":") + 1);
    const localName = branch.startsWith("origin/") ? branch.slice("origin/".length) : branch;
    const localExists = repo.branches.some((item) => !item.remote && item.name === localName);
    if (!repo.detached && localExists && localName === repo.branch) return;
    if (repo.dirty) {
      setPending({ path: repo.path, branch, name: repo.name });
      setWarnOpen(true);
      return;
    }
    void runSwitch(repo.path, branch, false);
  }

  async function refresh(repo: GitRepo) {
    setBusy((current) => ({ ...current, [repo.path]: "fetch" }));
    setRowError((current) => ({ ...current, [repo.path]: "" }));
    try {
      const next = await api<GitRepo>(`/api/workspaces/${props.workspaceId}/git/fetch`, {
        method: "POST",
        body: { path: repo.path },
      });
      replaceRepo(repo.path, next);
    } catch (reason) {
      setRowError((current) => ({ ...current, [repo.path]: reason instanceof Error ? reason.message : "刷新远程失败" }));
    } finally {
      setBusy((current) => {
        const next = { ...current };
        delete next[repo.path];
        return next;
      });
    }
  }

  async function showChanges(repo: GitRepo) {
    setChangesOpen(true);
    setChanges({ name: repo.name, files: [], loading: true, error: "" });
    setBusy((current) => ({ ...current, [repo.path]: "status" }));
    try {
      const body = await api<{ files: GitChange[] }>(`/api/workspaces/${props.workspaceId}/git/status`, {
        method: "POST",
        body: { path: repo.path },
      });
      setChanges({ name: repo.name, files: body.files, loading: false, error: "" });
    } catch (reason) {
      setChanges({
        name: repo.name,
        files: [],
        loading: false,
        error: reason instanceof Error ? reason.message : "读取改动失败",
      });
    } finally {
      setBusy((current) => {
        const next = { ...current };
        delete next[repo.path];
        return next;
      });
    }
  }

  return (
    <>
      <Dialog open={props.open} onOpenChange={props.onOpenChange}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Git 分支</DialogTitle>
            <DialogDescription>
              切换会改变这个 workspace 里仓库的当前分支，之后的聊天和工作流都会用新的分支。
            </DialogDescription>
          </DialogHeader>
          {loading ? <p className="text-sm text-muted-foreground">正在读取分支…</p> : null}
          {loadError ? <p className="text-sm text-destructive">{loadError}</p> : null}
          {!loading && !loadError && repos.length === 0 ? (
            <p className="text-sm text-muted-foreground">没有扫描到 Git 仓库。可以到设置里重新扫描。</p>
          ) : null}
          {repos.length > 0 ? (
            <ScrollArea className="max-h-[60vh] **:data-[slot=scroll-area-viewport]:max-h-[60vh]">
              <div className="flex flex-col gap-3 pr-3">
                {repos.map((repo) => {
                  const local = repo.branches.filter((item) => !item.remote);
                  const remote = repo.branches.filter((item) => item.remote);
                  const current = repo.detached ? "游离 HEAD" : repo.branch || "未知";
                  const rowBusy = busy[repo.path];
                  return (
                    <div key={repo.path} className="flex flex-col gap-2 border-b pb-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate font-medium" title={repo.path}>
                            {repo.name === "." ? "workspace 根目录" : repo.name}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {current}
                            {repo.dirty ? " · 有未提交改动" : ""}
                          </div>
                        </div>
                        <div className="flex shrink-0 gap-1">
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`刷新 ${repo.name} 的远程分支`}
                            title="刷新这个仓库的 origin"
                            disabled={Boolean(rowBusy)}
                            onClick={() => void refresh(repo)}
                          >
                            <RefreshCw className={rowBusy === "fetch" ? "animate-spin" : ""} />
                          </Button>
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`查看 ${repo.name} 的本地改动`}
                            title="查看未提交的文件"
                            disabled={Boolean(rowBusy)}
                            onClick={() => void showChanges(repo)}
                          >
                            <Diff />
                          </Button>
                        </div>
                      </div>
                      {repo.error ? <p className="text-xs text-destructive">{repo.error}</p> : null}
                      {!repo.error && (local.length > 0 || remote.length > 0) ? (
                        <Select
                          value={repo.detached ? undefined : `local:${repo.branch}`}
                          disabled={Boolean(rowBusy)}
                          onValueChange={(value) => pickBranch(repo, value)}
                        >
                          <SelectTrigger className="w-full" aria-label={`${repo.name} 的分支`}>
                            <SelectValue placeholder={repo.detached ? "游离 HEAD" : "选择分支"} />
                          </SelectTrigger>
                          <SelectContent>
                            {local.length > 0 ? (
                              <SelectGroup>
                                <SelectLabel>本地</SelectLabel>
                                {local.map((item) => (
                                  <SelectItem key={`local:${item.name}`} value={`local:${item.name}`}>
                                    {item.name}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            ) : null}
                            {remote.length > 0 ? (
                              <SelectGroup>
                                <SelectLabel>origin</SelectLabel>
                                {remote.map((item) => (
                                  <SelectItem key={`remote:${item.name}`} value={`remote:${item.name}`}>
                                    {item.name}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            ) : null}
                          </SelectContent>
                        </Select>
                      ) : null}
                      {rowError[repo.path] ? <p className="text-xs text-destructive">{rowError[repo.path]}</p> : null}
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={warnOpen} onOpenChange={(open) => { if (!open) setWarnOpen(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>工作区有未提交改动</DialogTitle>
            <DialogDescription>
              {pending?.name === "." ? "workspace 根目录" : pending?.name} 里有未提交的本地改动。可以先把这些改动全部 stash 起来，再切换到 {pending?.branch}。stash 不会自动应用到新分支，之后需要自己回到原来的分支执行 git stash pop。也可以放弃这次切换。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setWarnOpen(false)} disabled={pending ? busy[pending.path] === "switch" : false}>
              取消
            </Button>
            <Button
              type="button"
              disabled={pending ? busy[pending.path] === "switch" : false}
              onClick={() => {
                if (pending) void runSwitch(pending.path, pending.branch, true);
              }}
            >
              Stash 并切换
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={changesOpen} onOpenChange={(open) => { if (!open) setChangesOpen(false); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>本地改动</DialogTitle>
            <DialogDescription>
              {changes?.name === "." ? "workspace 根目录" : changes?.name}。这里列出文件和增删行数，不能提交或丢弃。
            </DialogDescription>
          </DialogHeader>
          {changes?.loading ? <p className="text-sm text-muted-foreground">正在读取…</p> : null}
          {changes?.error ? <p className="text-sm text-destructive">{changes.error}</p> : null}
          {changes && !changes.loading && !changes.error && changes.files.length === 0 ? (
            <p className="text-sm text-muted-foreground">工作区是干净的。</p>
          ) : null}
          {changes && changes.files.length > 0 ? (
            <ScrollArea className="max-h-72 **:data-[slot=scroll-area-viewport]:max-h-72">
              <ul className="flex flex-col gap-1 pr-3 font-mono text-xs">
                {changes.files.map((file) => (
                  <li key={`${file.code}:${file.path}`} className="flex items-baseline gap-2">
                    <span className="w-8 shrink-0 text-muted-foreground">{file.code}</span>
                    <span className="min-w-0 flex-1 break-all">{file.path}</span>
                    <LineStat added={file.added} deleted={file.deleted} />
                  </li>
                ))}
              </ul>
            </ScrollArea>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function LineStat(props: { added: number | null; deleted: number | null }) {
  if (props.added === null || props.deleted === null) {
    return <span className="shrink-0 text-muted-foreground">二进制</span>;
  }
  return (
    <span className="shrink-0 tabular-nums">
      <span className="text-emerald-600 dark:text-emerald-400">+{props.added}</span>{" "}
      <span className="text-red-600 dark:text-red-400">-{props.deleted}</span>
    </span>
  );
}

export function BranchButton(props: { onClick: () => void }) {
  return (
    <Button type="button" size="icon-sm" variant="ghost" aria-label="Git 分支" title="查看并切换 Git 分支" onClick={props.onClick}>
      <GitBranch />
    </Button>
  );
}

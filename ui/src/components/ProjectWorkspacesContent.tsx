import { useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ExecutionWorkspace } from "@paperclipai/shared";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";
import { type ProjectWorkspaceSummary } from "../lib/project-workspaces-tab";
import { projectWorkspaceUrl } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";
import { CopyText } from "./CopyText";
import { ExecutionWorkspaceCloseDialog } from "./ExecutionWorkspaceCloseDialog";
import { IssuesQuicklook } from "./IssuesQuicklook";
import { Button } from "@/components/ui/button";
import { Copy, FolderOpen, GitBranch, Loader2, Play, Square } from "lucide-react";

export function ProjectWorkspacesContent({
  companyId,
  projectId,
  projectRef,
  summaries,
}: {
  companyId: string;
  projectId: string;
  projectRef: string;
  summaries: ProjectWorkspaceSummary[];
}) {
  const queryClient = useQueryClient();
  const [runtimeActionKey, setRuntimeActionKey] = useState<string | null>(null);
  const [closingWorkspace, setClosingWorkspace] = useState<{
    id: string;
    name: string;
    status: ExecutionWorkspace["status"];
  } | null>(null);
  const controlWorkspaceRuntime = useMutation({
    mutationFn: async (input: {
      key: string;
      kind: "project_workspace" | "execution_workspace";
      workspaceId: string;
      action: "start" | "stop" | "restart";
    }) => {
      setRuntimeActionKey(`${input.key}:${input.action}`);
      if (input.kind === "project_workspace") {
        return await projectsApi.controlWorkspaceRuntimeServices(projectId, input.workspaceId, input.action, companyId);
      }
      return await executionWorkspacesApi.controlRuntimeServices(input.workspaceId, input.action);
    },
    onSettled: () => {
      setRuntimeActionKey(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.list(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.list(companyId, { projectId }) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByProject(companyId, projectId) });
    },
  });

  if (summaries.length === 0) {
    return <p className="text-sm text-muted-foreground">No non-default workspace activity yet.</p>;
  }

  const activeSummaries = summaries.filter((summary) => summary.executionWorkspaceStatus !== "cleanup_failed");
  const cleanupFailedSummaries = summaries.filter((summary) => summary.executionWorkspaceStatus === "cleanup_failed");

  const renderSummaryRow = (summary: ProjectWorkspaceSummary) => {
    const visibleIssues = summary.issues.slice(0, 5);
    const hiddenIssueCount = Math.max(summary.issues.length - visibleIssues.length, 0);
    const workspaceHref =
      summary.kind === "project_workspace"
        ? projectWorkspaceUrl({ id: projectRef, urlKey: projectRef }, summary.workspaceId)
        : `/execution-workspaces/${summary.workspaceId}`;
    const hasRunningServices = summary.runningServiceCount > 0;

    const truncatePath = (cwdPath: string) => {
      const parts = cwdPath.split("/").filter(Boolean);
      if (parts.length <= 3) return cwdPath;
      return `…/${parts.slice(-2).join("/")}`;
    };

    return (
      <div
        key={summary.key}
        className="border-b border-border px-4 py-3 last:border-b-0"
      >
        <div className="flex items-center gap-3">
          <Link
            to={workspaceHref}
            className="min-w-0 shrink truncate text-sm font-medium hover:underline"
          >
            {summary.workspaceName}
          </Link>

          <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            {summary.serviceCount > 0 ? (
              <span className={`inline-flex items-center gap-1 ${hasRunningServices ? "text-emerald-500" : ""}`}>
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${hasRunningServices ? "bg-emerald-500" : "bg-muted-foreground/40"}`} />
                {summary.runningServiceCount}/{summary.serviceCount}
              </span>
            ) : null}
            {summary.executionWorkspaceStatus && summary.executionWorkspaceStatus !== "active" ? (
              <span className="text-[11px] text-muted-foreground">{summary.executionWorkspaceStatus}</span>
            ) : null}
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <span className="text-xs text-muted-foreground">{timeAgo(summary.lastUpdatedAt)}</span>
            {summary.hasRuntimeConfig ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs"
                disabled={controlWorkspaceRuntime.isPending}
                onClick={() =>
                  controlWorkspaceRuntime.mutate({
                    key: summary.key,
                    kind: summary.kind,
                    workspaceId: summary.workspaceId,
                    action: hasRunningServices ? "stop" : "start",
                  })
                }
              >
                {runtimeActionKey === `${summary.key}:start` || runtimeActionKey === `${summary.key}:stop` ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : hasRunningServices ? (
                  <Square className="h-3 w-3" />
                ) : (
                  <Play className="h-3 w-3" />
                )}
                {hasRunningServices ? "Stop" : "Start"}
              </Button>
            ) : null}
            {summary.kind === "execution_workspace" && summary.executionWorkspaceId && summary.executionWorkspaceStatus ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground"
                onClick={() => setClosingWorkspace({
                  id: summary.executionWorkspaceId!,
                  name: summary.workspaceName,
                  status: summary.executionWorkspaceStatus!,
                })}
              >
                {summary.executionWorkspaceStatus === "cleanup_failed" ? "Retry close" : "Close"}
              </Button>
            ) : null}
          </div>
        </div>

        <div className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
          {summary.branchName ? (
            <div className="flex items-center gap-1.5">
              <GitBranch className="h-3 w-3 shrink-0" />
              <span className="font-mono">{summary.branchName}</span>
            </div>
          ) : null}
          {summary.cwd ? (
            <div className="flex items-center gap-1.5">
              <FolderOpen className="h-3 w-3 shrink-0" />
              <span className="truncate font-mono" title={summary.cwd}>
                {truncatePath(summary.cwd)}
              </span>
              <CopyText text={summary.cwd} className="shrink-0" copiedLabel="Path copied">
                <Copy className="h-3 w-3" />
              </CopyText>
            </div>
          ) : null}
          {summary.primaryServiceUrl ? (
            <div className="flex items-center gap-1.5">
              <a
                href={summary.primaryServiceUrl}
                target="_blank"
                rel="noreferrer"
                className="font-mono hover:text-foreground hover:underline"
              >
                {summary.primaryServiceUrl}
              </a>
            </div>
          ) : null}
        </div>

        {summary.issues.length > 0 ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="font-medium text-muted-foreground/70">Issues</span>
            {visibleIssues.map((issue) => (
              <IssuesQuicklook key={issue.id} issue={issue}>
                <Link
                  to={`/issues/${issue.identifier ?? issue.id}`}
                  className="font-mono hover:text-foreground hover:underline"
                >
                  {issue.identifier ?? issue.id.slice(0, 8)}
                </Link>
              </IssuesQuicklook>
            ))}
            {hiddenIssueCount > 0 ? (
              <Link to={workspaceHref} className="hover:text-foreground hover:underline">
                +{hiddenIssueCount} more
              </Link>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <>
      <div className="space-y-4">
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {activeSummaries.map(renderSummaryRow)}
        </div>
        {cleanupFailedSummaries.length > 0 ? (
          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Cleanup attention needed
            </div>
            <div className="overflow-hidden rounded-xl border border-amber-500/20 bg-amber-500/5">
              {cleanupFailedSummaries.map(renderSummaryRow)}
            </div>
          </div>
        ) : null}
      </div>
      {closingWorkspace ? (
        <ExecutionWorkspaceCloseDialog
          workspaceId={closingWorkspace.id}
          workspaceName={closingWorkspace.name}
          currentStatus={closingWorkspace.status}
          open
          onOpenChange={(open) => {
            if (!open) setClosingWorkspace(null);
          }}
          onClosed={() => {
            queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.list(companyId) });
            queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.list(companyId, { projectId }) });
            queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
            queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(companyId) });
            queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
            queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByProject(companyId, projectId) });
            setClosingWorkspace(null);
          }}
        />
      ) : null}
    </>
  );
}

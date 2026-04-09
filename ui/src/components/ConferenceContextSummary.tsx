import type { ConferenceContext, GitSnapshotFile } from "@paperclipai/shared";

function SummaryField({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  if (!value) return null;
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </p>
      <p className="text-sm leading-6 text-foreground/90">{value}</p>
    </div>
  );
}

function GitFileEntry({ file }: { file: GitSnapshotFile }) {
  return (
    <li className="flex items-start justify-between gap-3 rounded-lg border border-border/60 bg-card/70 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-xs text-foreground">{file.path}</p>
        {file.previousPath ? (
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            from {file.previousPath}
          </p>
        ) : null}
      </div>
      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
        {file.status}
      </span>
    </li>
  );
}

export function ConferenceContextSummary({
  context,
  title = "Repo Context",
  emptyMessage = "No inspectable repo context is available for this issue.",
}: {
  context: ConferenceContext | null | undefined;
  title?: string;
  emptyMessage?: string;
}) {
  if (!context) {
    return (
      <div className="rounded-xl border border-border/60 bg-background/70 p-4">
        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          {title}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">{emptyMessage}</p>
      </div>
    );
  }

  const hasWorkspaceSummary = Boolean(context.projectWorkspace || context.executionWorkspace);
  const hasGitSnapshot = Boolean(context.git);

  return (
    <div className="rounded-xl border border-border/60 bg-background/70 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            {title}
          </p>
          <p className="text-sm text-muted-foreground">
            Captured {new Date(context.capturedAt).toLocaleString()}
          </p>
        </div>
      </div>

      {hasWorkspaceSummary ? (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {context.projectWorkspace ? (
            <div className="rounded-lg border border-border/60 bg-card/70 p-3">
              <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                Project Workspace
              </p>
              <div className="mt-2 space-y-2">
                <SummaryField label="Name" value={context.projectWorkspace.name} />
                <SummaryField label="Source" value={context.projectWorkspace.sourceType} />
                <SummaryField label="Repo URL" value={context.projectWorkspace.repoUrl} />
                <SummaryField label="Repo Ref" value={context.projectWorkspace.repoRef} />
                <SummaryField label="Default Ref" value={context.projectWorkspace.defaultRef} />
              </div>
            </div>
          ) : null}
          {context.executionWorkspace ? (
            <div className="rounded-lg border border-border/60 bg-card/70 p-3">
              <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                Execution Workspace
              </p>
              <div className="mt-2 space-y-2">
                <SummaryField label="Name" value={context.executionWorkspace.name} />
                <SummaryField label="Mode" value={context.executionWorkspace.mode} />
                <SummaryField label="Status" value={context.executionWorkspace.status} />
                <SummaryField label="Provider" value={context.executionWorkspace.providerType} />
                <SummaryField label="Repo URL" value={context.executionWorkspace.repoUrl} />
                <SummaryField label="Branch" value={context.executionWorkspace.branchName} />
                <SummaryField label="Base Ref" value={context.executionWorkspace.baseRef} />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {hasGitSnapshot ? (
        <div className="mt-4 rounded-lg border border-border/60 bg-card/70 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Git Snapshot
            </p>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {context.git?.branchName ?? "Detached HEAD"}
            </span>
            {context.git?.baseRef ? (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                base {context.git.baseRef}
              </span>
            ) : null}
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <SummaryField label="Root" value={context.git?.displayRootPath} />
            <SummaryField label="Workspace" value={context.git?.displayWorkspacePath} />
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span className="rounded bg-muted px-2 py-1">
              dirty {context.git?.dirtyEntryCount ?? 0}
            </span>
            <span className="rounded bg-muted px-2 py-1">
              untracked {context.git?.untrackedEntryCount ?? 0}
            </span>
            <span className="rounded bg-muted px-2 py-1">
              ahead {context.git?.aheadCount ?? 0}
            </span>
            <span className="rounded bg-muted px-2 py-1">
              behind {context.git?.behindCount ?? 0}
            </span>
            <span className="rounded bg-muted px-2 py-1">
              files {context.git?.changedFileCount ?? 0}
            </span>
          </div>

          {(context.git?.changedFiles.length ?? 0) > 0 ? (
            <div className="mt-4 space-y-2">
              <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                Changed Files
              </p>
              <ul className="space-y-2">
                {context.git?.changedFiles.map((file) => (
                  <GitFileEntry key={`${file.status}:${file.previousPath ?? ""}:${file.path}`} file={file} />
                ))}
              </ul>
              {context.git?.truncated ? (
                <p className="text-xs text-muted-foreground">
                  Showing the first {context.git.changedFiles.length} of {context.git.changedFileCount} changed files.
                </p>
              ) : null}
            </div>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">
              No changed files were captured for this snapshot.
            </p>
          )}
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">
          No local git snapshot was available for this issue.
        </p>
      )}
    </div>
  );
}

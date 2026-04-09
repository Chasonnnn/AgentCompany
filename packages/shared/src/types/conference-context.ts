import type { ProjectWorkspaceSourceType } from "./project.js";
import type { ExecutionWorkspaceProviderType, ExecutionWorkspaceStatus } from "./workspace-runtime.js";

export type GitSnapshotStatusCode = " " | "M" | "T" | "A" | "D" | "R" | "C" | "U" | "?";
export type GitSnapshotFileStatus = `${GitSnapshotStatusCode}${GitSnapshotStatusCode}`;

export interface ConferenceProjectWorkspaceSummary {
  id: string;
  projectId: string;
  name: string;
  sourceType: ProjectWorkspaceSourceType;
  isPrimary: boolean;
  repoUrl: string | null;
  repoRef: string | null;
  defaultRef: string | null;
}

export interface ConferenceExecutionWorkspaceSummary {
  id: string;
  projectId: string;
  projectWorkspaceId: string | null;
  name: string;
  mode: "shared_workspace" | "isolated_workspace" | "operator_branch" | "adapter_managed" | "cloud_sandbox";
  status: ExecutionWorkspaceStatus;
  providerType: ExecutionWorkspaceProviderType;
  repoUrl: string | null;
  baseRef: string | null;
  branchName: string | null;
}

export interface GitSnapshotFile {
  path: string;
  previousPath: string | null;
  indexStatus: GitSnapshotStatusCode;
  worktreeStatus: GitSnapshotStatusCode;
  status: GitSnapshotFileStatus;
}

export interface GitSnapshot {
  rootPath: string | null;
  workspacePath: string | null;
  displayRootPath: string | null;
  displayWorkspacePath: string | null;
  branchName: string | null;
  baseRef: string | null;
  isGit: boolean;
  dirty: boolean;
  dirtyEntryCount: number;
  untrackedEntryCount: number;
  aheadCount: number | null;
  behindCount: number | null;
  changedFileCount: number;
  truncated: boolean;
  changedFiles: GitSnapshotFile[];
}

export interface ConferenceContext {
  capturedAt: string;
  projectWorkspace: ConferenceProjectWorkspaceSummary | null;
  executionWorkspace: ConferenceExecutionWorkspaceSummary | null;
  git: GitSnapshot | null;
}

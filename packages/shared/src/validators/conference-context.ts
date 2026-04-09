import { z } from "zod";
import type {
  ConferenceContext,
  ConferenceExecutionWorkspaceSummary,
  ConferenceProjectWorkspaceSummary,
  GitSnapshot,
  GitSnapshotFile,
  GitSnapshotFileStatus,
  GitSnapshotStatusCode,
} from "../types/conference-context.js";

const projectWorkspaceSourceTypeSchema = z.enum([
  "local_path",
  "git_repo",
  "remote_managed",
  "non_git_path",
]);

const executionWorkspaceStatusSchema = z.enum([
  "active",
  "idle",
  "in_review",
  "archived",
  "cleanup_failed",
]);

const executionWorkspaceProviderTypeSchema = z.enum([
  "local_fs",
  "git_worktree",
  "adapter_managed",
  "cloud_sandbox",
]);

export const gitSnapshotStatusCodeSchema = z.enum([
  " ",
  "M",
  "T",
  "A",
  "D",
  "R",
  "C",
  "U",
  "?",
]) satisfies z.ZodType<GitSnapshotStatusCode>;

export const conferenceProjectWorkspaceSummarySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  name: z.string().min(1),
  sourceType: projectWorkspaceSourceTypeSchema,
  isPrimary: z.boolean(),
  repoUrl: z.string().nullable(),
  repoRef: z.string().nullable(),
  defaultRef: z.string().nullable(),
}).strict() satisfies z.ZodType<ConferenceProjectWorkspaceSummary>;

export const conferenceExecutionWorkspaceModeSchema = z.enum([
  "shared_workspace",
  "isolated_workspace",
  "operator_branch",
  "adapter_managed",
  "cloud_sandbox",
]);

export const conferenceExecutionWorkspaceSummarySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  projectWorkspaceId: z.string().uuid().nullable(),
  name: z.string().min(1),
  mode: conferenceExecutionWorkspaceModeSchema,
  status: executionWorkspaceStatusSchema,
  providerType: executionWorkspaceProviderTypeSchema,
  repoUrl: z.string().nullable(),
  baseRef: z.string().nullable(),
  branchName: z.string().nullable(),
}).strict() satisfies z.ZodType<ConferenceExecutionWorkspaceSummary>;

const gitSnapshotFileStatusSchema = z.custom<GitSnapshotFileStatus>(
  (value): value is GitSnapshotFileStatus =>
    typeof value === "string" && value.length === 2,
  { message: "status must be a 2-character porcelain status code" },
);

export const gitSnapshotFileSchema = z.object({
  path: z.string().min(1),
  previousPath: z.string().min(1).nullable(),
  indexStatus: gitSnapshotStatusCodeSchema,
  worktreeStatus: gitSnapshotStatusCodeSchema,
  status: gitSnapshotFileStatusSchema,
}).strict().superRefine((value, ctx) => {
  const expectedStatus = `${value.indexStatus}${value.worktreeStatus}`;
  if (value.status !== expectedStatus) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `status must equal ${expectedStatus}`,
      path: ["status"],
    });
  }
}) satisfies z.ZodType<GitSnapshotFile>;

export const gitSnapshotSchema = z.object({
  rootPath: z.string().nullable(),
  workspacePath: z.string().nullable(),
  displayRootPath: z.string().nullable(),
  displayWorkspacePath: z.string().nullable(),
  branchName: z.string().nullable(),
  baseRef: z.string().nullable(),
  isGit: z.boolean(),
  dirty: z.boolean(),
  dirtyEntryCount: z.number().int().nonnegative(),
  untrackedEntryCount: z.number().int().nonnegative(),
  aheadCount: z.number().int().nonnegative().nullable(),
  behindCount: z.number().int().nonnegative().nullable(),
  changedFileCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  changedFiles: z.array(gitSnapshotFileSchema),
}).strict() satisfies z.ZodType<GitSnapshot>;

export const conferenceContextSchema = z.object({
  capturedAt: z.string().datetime(),
  projectWorkspace: conferenceProjectWorkspaceSummarySchema.nullable(),
  executionWorkspace: conferenceExecutionWorkspaceSummarySchema.nullable(),
  git: gitSnapshotSchema.nullable(),
}).strict() satisfies z.ZodType<ConferenceContext>;

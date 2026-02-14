import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type AgentProfileSnapshot,
  type AllocationApplyPayload,
  type ClientIntakeRunResult,
  type DepartmentAssignResult,
  type DesktopBootstrapSnapshot,
  type ScopeKind,
  type ViewKind
} from "@/types";
import { rpcCall, slugify } from "./rpc";

export type SnapshotInput = {
  workspaceDir: string;
  actorId: string;
  scope: ScopeKind;
  projectId?: string;
  view: ViewKind;
  conversationId?: string;
};

function snapshotIntervalForView(view: ViewKind): number {
  if (view === "conversation") return 2500;
  if (view === "activities") return 4000;
  if (view === "resources") return 8000;
  return 7000;
}

function snapshotKey(input: SnapshotInput) {
  return [
    "desktop-bootstrap",
    input.workspaceDir,
    input.actorId,
    input.scope,
    input.projectId ?? "none",
    input.view,
    input.conversationId ?? "none"
  ] as const;
}

function trimTrailingSeparators(input: string): string {
  let out = input.trim();
  while (out.length > 1 && (out.endsWith("/") || out.endsWith("\\"))) {
    out = out.slice(0, -1);
  }
  return out;
}

function repoFolderName(repoPath: string): string {
  const normalized = trimTrailingSeparators(repoPath);
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function shortStableHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(0, 6);
}

export function deriveProjectNameFromRepoPath(repoPath: string): string {
  const folder = repoFolderName(repoPath);
  return folder || "Repository";
}

export function deriveRepoIdFromRepoPath(repoPath: string): string {
  const folder = repoFolderName(repoPath);
  const slug = slugify(folder) || "repo";
  return `repo_${slug}_${shortStableHash(trimTrailingSeparators(repoPath))}`;
}

export function useDesktopSnapshot(input: SnapshotInput, enabled: boolean) {
  const interval = useMemo(() => snapshotIntervalForView(input.view), [input.view]);
  return useQuery({
    queryKey: snapshotKey(input),
    enabled,
    queryFn: async () => {
      const params: Record<string, any> = {
        workspace_dir: input.workspaceDir,
        actor_id: input.actorId,
        scope: input.scope,
        view: input.view
      };
      if (input.projectId) params.project_id = input.projectId;
      if (input.conversationId) params.conversation_id = input.conversationId;
      return rpcCall<DesktopBootstrapSnapshot>("desktop.bootstrap.snapshot", params);
    },
    refetchInterval: () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return false;
      }
      return interval;
    },
    staleTime: 1000
  });
}

export function useAgentProfile(args: {
  workspaceDir: string;
  agentId?: string;
  projectId?: string;
}) {
  return useQuery({
    queryKey: ["agent-profile", args.workspaceDir, args.agentId ?? "none", args.projectId ?? "none"],
    enabled: Boolean(args.workspaceDir && args.agentId),
    queryFn: async () =>
      rpcCall<AgentProfileSnapshot>("agent.profile.snapshot", {
        workspace_dir: args.workspaceDir,
        agent_id: args.agentId ?? "",
        ...(args.projectId ? { project_id: args.projectId } : {})
      }),
    staleTime: 10_000
  });
}

export function useDesktopActions() {
  const queryClient = useQueryClient();

  const invalidateSnapshots = async () => {
    await queryClient.invalidateQueries({
      queryKey: ["desktop-bootstrap"]
    });
  };

  const createProject = useMutation({
    mutationFn: async (args: {
      workspaceDir: string;
      actorId: string;
      repoPath: string;
    }) => {
      const repoPath = trimTrailingSeparators(args.repoPath);
      if (!repoPath) {
        throw new Error("Select a repository folder.");
      }
      const projectName = deriveProjectNameFromRepoPath(repoPath);
      const repoId = deriveRepoIdFromRepoPath(repoPath);
      await rpcCall("workspace.repo_root.set", {
        workspace_dir: args.workspaceDir,
        repo_id: repoId,
        repo_path: repoPath
      });
      return rpcCall<{ project_id: string }>("workspace.project.create_with_defaults", {
        workspace_dir: args.workspaceDir,
        name: projectName,
        ceo_actor_id: args.actorId,
        repo_ids: [repoId]
      });
    },
    onSuccess: invalidateSnapshots
  });

  const createChannel = useMutation({
    mutationFn: async (args: {
      workspaceDir: string;
      scope: ScopeKind;
      projectId?: string;
      actorId: string;
      name: string;
      visibility: "private_agent" | "team" | "managers" | "org";
      participantAgentIds: string[];
      participantTeamIds: string[];
    }) =>
      rpcCall<{ id: string }>("conversation.create_channel", {
        workspace_dir: args.workspaceDir,
        scope: args.scope,
        ...(args.projectId ? { project_id: args.projectId } : {}),
        name: args.name,
        slug: slugify(args.name),
        visibility: args.visibility,
        created_by: args.actorId,
        participant_agent_ids: args.participantAgentIds,
        participant_team_ids: args.participantTeamIds
      }),
    onSuccess: invalidateSnapshots
  });

  const createDm = useMutation({
    mutationFn: async (args: {
      workspaceDir: string;
      scope: ScopeKind;
      projectId?: string;
      actorId: string;
      peerAgentId: string;
    }) =>
      rpcCall<{ id: string }>("conversation.create_dm", {
        workspace_dir: args.workspaceDir,
        scope: args.scope,
        ...(args.projectId ? { project_id: args.projectId } : {}),
        created_by: args.actorId,
        peer_agent_id: args.peerAgentId
      }),
    onSuccess: invalidateSnapshots
  });

  const sendMessage = useMutation({
    mutationFn: async (args: {
      workspaceDir: string;
      scope: ScopeKind;
      projectId?: string;
      conversationId: string;
      actorId: string;
      body: string;
    }) =>
      rpcCall("conversation.message.send", {
        workspace_dir: args.workspaceDir,
        scope: args.scope,
        ...(args.projectId ? { project_id: args.projectId } : {}),
        conversation_id: args.conversationId,
        author_id: args.actorId,
        author_role: "ceo",
        body: args.body
      }),
    onSuccess: invalidateSnapshots
  });

  const applyAllocations = useMutation({
    mutationFn: async (args: {
      workspaceDir: string;
      projectId: string;
      actorId: string;
      items: AllocationApplyPayload[];
    }) =>
      rpcCall("pm.apply_allocations", {
        workspace_dir: args.workspaceDir,
        project_id: args.projectId,
        applied_by: args.actorId,
        items: args.items
      }),
    onSuccess: invalidateSnapshots
  });

  const runClientIntake = useMutation({
    mutationFn: async (args: {
      workspaceDir: string;
      projectName: string;
      ceoActorId: string;
      executiveManagerAgentId: string;
      intakeText?: string;
    }) =>
      rpcCall<ClientIntakeRunResult>("pipeline.client_intake.run", {
        workspace_dir: args.workspaceDir,
        project_name: args.projectName,
        ceo_actor_id: args.ceoActorId,
        executive_manager_agent_id: args.executiveManagerAgentId,
        ...(args.intakeText ? { intake_text: args.intakeText } : {})
      }),
    onSuccess: invalidateSnapshots
  });

  const assignDepartmentTasks = useMutation({
    mutationFn: async (args: {
      workspaceDir: string;
      projectId: string;
      departmentKey: string;
      directorAgentId: string;
      workerAgentIds: string[];
      approvedExecutivePlanArtifactId: string;
    }) =>
      rpcCall<DepartmentAssignResult>("pipeline.department.assign_tasks", {
        workspace_dir: args.workspaceDir,
        project_id: args.projectId,
        department_key: args.departmentKey,
        director_agent_id: args.directorAgentId,
        worker_agent_ids: args.workerAgentIds,
        approved_executive_plan_artifact_id: args.approvedExecutivePlanArtifactId
      }),
    onSuccess: invalidateSnapshots
  });

  return {
    createProject,
    createChannel,
    createDm,
    sendMessage,
    applyAllocations,
    runClientIntake,
    assignDepartmentTasks,
    invalidateSnapshots
  };
}

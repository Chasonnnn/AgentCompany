import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type AgentProfileSnapshot,
  type AllocationApplyPayload,
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
      name: string;
      repoIds: string[];
    }) =>
      rpcCall<{ project_id: string }>("workspace.project.create_with_defaults", {
        workspace_dir: args.workspaceDir,
        name: args.name,
        ceo_actor_id: args.actorId,
        repo_ids: args.repoIds
      }),
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

  return {
    createProject,
    createChannel,
    createDm,
    sendMessage,
    applyAllocations,
    invalidateSnapshots
  };
}

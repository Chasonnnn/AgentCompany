import { useEffect, useMemo, useState } from "react";
import { Activity, Bot, RefreshCw, Search, Settings, Webhook } from "lucide-react";
import { Button } from "@/components/primitives/Button";
import { ErrorState } from "@/components/primitives/ErrorState";
import { Skeleton } from "@/components/primitives/Skeleton";
import { ConversationView } from "@/features/conversations/ConversationView";
import { CreateChannelModal } from "@/features/conversations/CreateChannelModal";
import { CreateDmModal } from "@/features/conversations/CreateDmModal";
import { CreateProjectModal } from "@/features/conversations/CreateProjectModal";
import { LiveOpsModal } from "@/features/live-ops/LiveOpsModal";
import { ProjectHome } from "@/features/pm/ProjectHome";
import { WorkspaceHome } from "@/features/pm/WorkspaceHome";
import { ActivitiesView } from "@/features/workspace/ActivitiesView";
import { ContextSidebar } from "@/features/workspace/ContextSidebar";
import { DetailsPane } from "@/features/workspace/DetailsPane";
import { ProjectRail } from "@/features/workspace/ProjectRail";
import { QuickSwitchModal } from "@/features/workspace/QuickSwitchModal";
import { ResourcesView } from "@/features/workspace/ResourcesView";
import { SettingsModal } from "@/features/workspace/SettingsModal";
import { useAgentProfile, useDesktopActions, useDesktopSnapshot } from "@/services/queries";
import { pickRepoFolder } from "@/services/rpc";
import type {
  AgentSummary,
  BootstrapActivitiesViewData,
  BootstrapConversationViewData,
  BootstrapHomeViewData,
  BootstrapResourcesViewData,
  ConversationSummary,
  ScopeKind,
  ViewKind
} from "@/types";

const SESSION_KEY = "agentcompany.desktop.react.v3.session";

type ScopeSelection = { kind: ScopeKind; projectId?: string };
type ViewSelection = { kind: ViewKind; conversationId?: string };

function defaultWorkspaceDir() {
  return "/Users/chason/AgentCompany/work";
}

function loadSession(): {
  workspaceDir: string;
  actorId: string;
  reduceTransparency: boolean;
  scope: ScopeSelection;
  view: ViewSelection;
} {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) {
      return {
        workspaceDir: defaultWorkspaceDir(),
        actorId: "human_ceo",
        reduceTransparency: false,
        scope: { kind: "workspace" },
        view: { kind: "home" }
      };
    }
    const parsed = JSON.parse(raw) as any;
    return {
      workspaceDir: String(parsed.workspaceDir || defaultWorkspaceDir()),
      actorId: String(parsed.actorId || "human_ceo"),
      reduceTransparency: Boolean(parsed.reduceTransparency),
      scope:
        parsed.scope?.kind === "project" && parsed.scope?.projectId
          ? { kind: "project", projectId: String(parsed.scope.projectId) }
          : { kind: "workspace" },
      view:
        parsed.view?.kind === "conversation" && parsed.view?.conversationId
          ? { kind: "conversation", conversationId: String(parsed.view.conversationId) }
          : parsed.view?.kind === "activities"
            ? { kind: "activities" }
            : parsed.view?.kind === "resources"
              ? { kind: "resources" }
              : { kind: "home" }
    };
  } catch {
    return {
      workspaceDir: defaultWorkspaceDir(),
      actorId: "human_ceo",
      reduceTransparency: false,
      scope: { kind: "workspace" },
      view: { kind: "home" }
    };
  }
}

export function AppShell() {
  const session = useMemo(loadSession, []);
  const [workspaceDir, setWorkspaceDir] = useState(session.workspaceDir);
  const [actorId, setActorId] = useState(session.actorId);
  const [reduceTransparency, setReduceTransparency] = useState(session.reduceTransparency);
  const [scope, setScope] = useState<ScopeSelection>(session.scope);
  const [view, setView] = useState<ViewSelection>(session.view);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");

  const [showSettings, setShowSettings] = useState(false);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [showCreateDm, setShowCreateDm] = useState(false);
  const [showQuickSwitch, setShowQuickSwitch] = useState(false);
  const [showLiveOps, setShowLiveOps] = useState(false);
  const [inlineError, setInlineError] = useState("");

  useEffect(() => {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        workspaceDir,
        actorId,
        reduceTransparency,
        scope,
        view
      })
    );
  }, [workspaceDir, actorId, reduceTransparency, scope, view]);

  useEffect(() => {
    document.body.classList.toggle("reduce-transparency", reduceTransparency);
  }, [reduceTransparency]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setShowQuickSwitch(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const snapshot = useDesktopSnapshot(
    {
      workspaceDir,
      actorId,
      scope: scope.kind,
      projectId: scope.projectId,
      view: view.kind,
      conversationId: view.conversationId
    },
    Boolean(workspaceDir)
  );

  const actions = useDesktopActions();

  const projects = snapshot.data?.projects ?? [];
  const teams = snapshot.data?.teams ?? [];
  const agents = snapshot.data?.agents ?? [];
  const conversations = snapshot.data?.conversations ?? [];

  useEffect(() => {
    if (scope.kind === "project" && scope.projectId && !projects.some((p) => p.project_id === scope.projectId)) {
      setScope({ kind: "workspace" });
      setView({ kind: "home" });
    }
  }, [scope, projects]);

  useEffect(() => {
    if (view.kind !== "conversation") return;
    if (view.conversationId && conversations.some((c) => c.id === view.conversationId)) return;
    const fallback = conversations.find((c) => c.kind === "home") ?? conversations[0];
    if (fallback) {
      setView({ kind: "conversation", conversationId: fallback.id });
    } else {
      setView({ kind: "home" });
    }
  }, [view, conversations]);

  const project = projects.find((row) => row.project_id === scope.projectId);
  const selectedConversation =
    view.kind === "conversation" ? conversations.find((c) => c.id === view.conversationId) : undefined;

  const participants = useMemo(() => {
    if (!selectedConversation) return [] as AgentSummary[];
    const ids = new Set<string>(selectedConversation.participants.agent_ids);
    ids.add(actorId);
    const out: AgentSummary[] = [];
    for (const id of ids) {
      if (id === actorId && !agents.some((agent) => agent.agent_id === actorId)) {
        out.push({
          agent_id: actorId,
          name: "You",
          role: "ceo",
          provider: "manual",
          created_at: new Date().toISOString()
        });
        continue;
      }
      const agent = agents.find((row) => row.agent_id === id);
      if (agent) out.push(agent);
    }
    return out;
  }, [selectedConversation, agents, actorId]);

  useEffect(() => {
    if (participants.length === 0) {
      setSelectedAgentId("");
      return;
    }
    if (!selectedAgentId || !participants.some((row) => row.agent_id === selectedAgentId)) {
      setSelectedAgentId(participants[0].agent_id);
    }
  }, [participants, selectedAgentId]);

  const profile = useAgentProfile({
    workspaceDir,
    agentId: selectedAgentId || undefined,
    projectId: scope.projectId
  });

  const header = useMemo(() => {
    if (view.kind === "home") {
      return {
        title: scope.kind === "workspace" ? "Workspace Home" : `${project?.name ?? "Project"} Home`,
        subtitle:
          scope.kind === "workspace"
            ? "Portfolio command center"
            : "Project management center with CPM/Gantt and allocations"
      };
    }
    if (view.kind === "activities") {
      return { title: "Activities", subtitle: "Approvals, reports, mentions, and run status signals" };
    }
    if (view.kind === "resources") {
      return { title: "Resources", subtitle: "Token, cost, worker load, and provider-model usage" };
    }
    return {
      title: selectedConversation?.name ?? "Conversation",
      subtitle: "Channel / DM timeline"
    };
  }, [view, scope, project, selectedConversation]);

  async function openDmForAgent(agentId: string) {
    try {
      const result = await actions.createDm.mutateAsync({
        workspaceDir,
        scope: scope.kind,
        projectId: scope.projectId,
        actorId,
        peerAgentId: agentId
      });
      setView({ kind: "conversation", conversationId: result.id });
      setShowCreateDm(false);
      setInlineError("");
    } catch (error) {
      setInlineError(error instanceof Error ? error.message : String(error));
    }
  }

  const isLoading = snapshot.isPending;
  const loadError = snapshot.error instanceof Error ? snapshot.error.message : "";

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-title">
          <h1>AgentCompany v{__APP_VERSION__}</h1>
          <p>{scope.kind === "workspace" ? "Workspace scope" : `${project?.name ?? "Project"} scope`}</p>
        </div>
        <div className="header-actions no-drag">
          <Button iconOnly onClick={() => void snapshot.refetch()} title="Refresh">
            <RefreshCw size={15} />
          </Button>
          <Button iconOnly onClick={() => setShowQuickSwitch(true)} title="Quick switch (Cmd/Ctrl+K)">
            <Search size={15} />
          </Button>
          <Button iconOnly onClick={() => setShowLiveOps(true)} title="Live Ops fallback">
            <Webhook size={15} />
          </Button>
          <Button iconOnly onClick={() => setShowSettings(true)} title="Settings">
            <Settings size={15} />
          </Button>
        </div>
      </header>

      <main className={`shell-grid ${selectedConversation ? "with-details" : "no-details"}`}>
        <ProjectRail
          projects={projects}
          selectedScope={scope}
          onSelectWorkspace={() => {
            setScope({ kind: "workspace" });
            setView({ kind: "home" });
          }}
          onSelectProject={(projectId) => {
            setScope({ kind: "project", projectId });
            setView({ kind: "home" });
          }}
          onCreateProject={() => setShowCreateProject(true)}
          onOpenSettings={() => setShowSettings(true)}
          onQuickSwitch={() => setShowQuickSwitch(true)}
        />

        <ContextSidebar
          scope={scope.kind}
          project={project}
          conversations={conversations}
          activeView={view.kind}
          activeConversationId={view.conversationId}
          onOpenHome={() => setView({ kind: "home" })}
          onOpenActivities={() => setView({ kind: "activities" })}
          onOpenResources={() => setView({ kind: "resources" })}
          onOpenConversation={(conversationId) => setView({ kind: "conversation", conversationId })}
          onCreateChannel={() => setShowCreateChannel(true)}
          onCreateDm={() => setShowCreateDm(true)}
        />

        <section className="content-pane">
          <header className="content-header">
            <div>
              <h2>{header.title}</h2>
              <p>{header.subtitle}</p>
            </div>
            <div className="hstack">
              <Button onClick={() => setView({ kind: "activities" })}>
                <Activity size={14} />
                &nbsp;Activities
              </Button>
              <Button onClick={() => setView({ kind: "resources" })}>
                <Bot size={14} />
                &nbsp;Resources
              </Button>
            </div>
          </header>

          {isLoading ? (
            <section className="content-body stack">
              <Skeleton height={18} />
              <Skeleton height={18} />
              <Skeleton height={18} />
            </section>
          ) : loadError ? (
            <section className="content-body">
              <ErrorState message={loadError} />
            </section>
          ) : (
            <ContentView
              view={view}
              scope={scope}
              data={snapshot.data}
              agents={agents}
              sending={actions.sendMessage.isPending}
              applying={actions.applyAllocations.isPending}
              onOpenProject={(projectId) => {
                setScope({ kind: "project", projectId });
                setView({ kind: "home" });
              }}
              onSendMessage={async (body) => {
                if (!view.conversationId) return;
                await actions.sendMessage.mutateAsync({
                  workspaceDir,
                  scope: scope.kind,
                  projectId: scope.projectId,
                  conversationId: view.conversationId,
                  actorId,
                  body
                });
              }}
              onApplyAllocation={async (items) => {
                if (!scope.projectId) return;
                await actions.applyAllocations.mutateAsync({
                  workspaceDir,
                  projectId: scope.projectId,
                  actorId,
                  items
                });
              }}
            />
          )}
        </section>

        <DetailsPane
          participants={participants}
          selectedAgentId={selectedAgentId}
          onSelectAgent={setSelectedAgentId}
          profile={profile.data}
          loadingProfile={profile.isPending}
          hasConversation={Boolean(selectedConversation)}
          onQuickDm={(agentId) => {
            void openDmForAgent(agentId);
          }}
        />
      </main>

      {inlineError ? (
        <div
          style={{
            position: "fixed",
            bottom: 14,
            right: 14,
            background: "#fff",
            border: "1px solid rgba(183,37,37,0.3)",
            color: "var(--danger)",
            borderRadius: 10,
            padding: "8px 10px",
            maxWidth: 460,
            zIndex: 900
          }}
        >
          {inlineError}
        </div>
      ) : null}

      <SettingsModal
        open={showSettings}
        workspaceDir={workspaceDir}
        actorId={actorId}
        reduceTransparency={reduceTransparency}
        onClose={() => setShowSettings(false)}
        onSave={({ workspaceDir: nextWorkspace, actorId: nextActor, reduceTransparency: nextReduce }) => {
          setWorkspaceDir(nextWorkspace);
          setActorId(nextActor);
          setReduceTransparency(nextReduce);
          setShowSettings(false);
          void actions.invalidateSnapshots();
        }}
      />

      <CreateProjectModal
        open={showCreateProject}
        pending={actions.createProject.isPending}
        onClose={() => setShowCreateProject(false)}
        onSubmit={async ({ repoPath }) => {
          const created = await actions.createProject.mutateAsync({
            workspaceDir,
            actorId,
            repoPath
          });
          setScope({ kind: "project", projectId: created.project_id });
          setView({ kind: "home" });
          setShowCreateProject(false);
        }}
        onPickRepoFolder={pickRepoFolder}
      />

      <CreateChannelModal
        open={showCreateChannel}
        pending={actions.createChannel.isPending}
        teams={teams}
        agents={agents}
        onClose={() => setShowCreateChannel(false)}
        onSubmit={async ({ name, visibility, teamId, participantAgentIds, participantTeamIds }) => {
          const created = await actions.createChannel.mutateAsync({
            workspaceDir,
            scope: scope.kind,
            projectId: scope.projectId,
            actorId,
            name,
            visibility,
            participantAgentIds,
            participantTeamIds: teamId ? [teamId] : participantTeamIds
          });
          setView({ kind: "conversation", conversationId: created.id });
          setShowCreateChannel(false);
        }}
      />

      <CreateDmModal
        open={showCreateDm}
        pending={actions.createDm.isPending}
        agents={agents.filter((agent) => agent.agent_id !== actorId)}
        onClose={() => setShowCreateDm(false)}
        onSubmit={openDmForAgent}
      />

      <QuickSwitchModal
        open={showQuickSwitch}
        projects={projects}
        onClose={() => setShowQuickSwitch(false)}
        onSelectWorkspace={() => {
          setScope({ kind: "workspace" });
          setView({ kind: "home" });
        }}
        onSelectProject={(projectId) => {
          setScope({ kind: "project", projectId });
          setView({ kind: "home" });
        }}
      />

      <LiveOpsModal
        open={showLiveOps}
        workspaceDir={workspaceDir}
        projectId={scope.projectId}
        actorId={actorId}
        onClose={() => setShowLiveOps(false)}
      />
    </div>
  );
}

function ContentView(props: {
  view: ViewSelection;
  scope: ScopeSelection;
  data: any;
  agents: AgentSummary[];
  sending: boolean;
  applying: boolean;
  onOpenProject: (projectId: string) => void;
  onSendMessage: (body: string) => Promise<void>;
  onApplyAllocation: (items: Array<{
    task_id: string;
    preferred_provider?: string;
    preferred_model?: string;
    preferred_agent_id?: string;
    token_budget_hint?: number;
  }>) => Promise<void>;
}) {
  const viewData = props.data?.view_data;

  if (props.view.kind === "home" && viewData && "pm" in viewData) {
    const home = viewData as BootstrapHomeViewData;
    if (props.scope.kind === "workspace") {
      return (
        <section className="content-body">
          <WorkspaceHome
            workspaceHome={home.workspace_home}
            pm={home.pm}
            resources={home.resources}
            onOpenProject={props.onOpenProject}
          />
        </section>
      );
    }
    if (home.pm.project) {
      return (
        <section className="content-body">
          <ProjectHome
            projectPm={home.pm.project}
            resources={home.resources}
            recommendations={home.recommendations ?? []}
            applying={props.applying}
            onApplyAll={props.onApplyAllocation}
            onApplyOne={async (item) => props.onApplyAllocation([item])}
          />
        </section>
      );
    }
    return (
      <section className="content-body">
        <ErrorState message="Project PM snapshot is unavailable." />
      </section>
    );
  }

  if (props.view.kind === "activities" && viewData && "ui" in viewData) {
    const activities = viewData as BootstrapActivitiesViewData;
    return (
      <section className="content-body">
        <ActivitiesView ui={activities.ui} />
      </section>
    );
  }

  if (props.view.kind === "resources" && viewData && "resources" in viewData) {
    const resources = viewData as BootstrapResourcesViewData;
    return (
      <section className="content-body">
        <ResourcesView resources={resources.resources} />
      </section>
    );
  }

  if (props.view.kind === "conversation" && viewData && "messages" in viewData) {
    const conversation = viewData as BootstrapConversationViewData;
    return (
      <ConversationView
        messages={conversation.messages}
        agents={props.agents}
        sending={props.sending}
        onSendMessage={props.onSendMessage}
      />
    );
  }

  return (
    <section className="content-body">
      <ErrorState message="Selected view payload is unavailable." />
    </section>
  );
}

import { type ReactNode, useEffect, useMemo, useState } from "react";
import { NavLink, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, FolderTree, Plus } from "lucide-react";
import type {
  Agent,
  AgentHierarchyMemberSummary,
  AgentNavigationClusterNode,
  AgentNavigationDepartmentNode,
  AgentNavigationLayout,
  AgentNavigationProjectNode,
  AgentNavigationTeamNode,
  CompanyAgentNavigation,
} from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { getStoredAgentLayout, setStoredAgentLayout } from "../lib/agent-layout";
import { queryKeys } from "../lib/queryKeys";
import { agentRouteRef, agentUrl, cn } from "../lib/utils";
import { AgentIcon } from "./AgentIconPicker";
import { BudgetSidebarMarker } from "./BudgetSidebarMarker";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

function HierarchyFolder({
  label,
  defaultOpen = true,
  depth = 0,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  depth?: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className="flex w-full items-center gap-1 px-3 py-1 text-left text-[11px] uppercase tracking-[0.16em] text-muted-foreground/80 hover:text-foreground"
        style={{ paddingLeft: 12 + depth * 16 }}
      >
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
        <FolderTree className="h-3 w-3 shrink-0" />
        <span className="truncate">{label}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

function SidebarAgentLink({
  summary,
  agent,
  activeAgentId,
  activeTab,
  runCount,
}: {
  summary: AgentHierarchyMemberSummary;
  agent: Agent | null;
  activeAgentId: string | null;
  activeTab: string | null;
  runCount: number;
}) {
  const { isMobile, setSidebarOpen } = useSidebar();
  const target = agent ?? summary;
  return (
    <NavLink
      to={activeTab ? `${agentUrl(target)}/${activeTab}` : agentUrl(target)}
      onClick={() => {
        if (isMobile) setSidebarOpen(false);
      }}
      className={cn(
        "flex items-center gap-2.5 px-3 py-1.5 text-[13px] font-medium transition-colors",
        activeAgentId === agentRouteRef(target)
          ? "bg-accent text-foreground"
          : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
      )}
    >
      <AgentIcon icon={agent?.icon ?? summary.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate">{summary.name}</span>
      {((agent?.pauseReason ?? null) === "budget" || runCount > 0) && (
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {(agent?.pauseReason ?? null) === "budget" ? (
            <BudgetSidebarMarker title="Agent paused by budget" />
          ) : null}
          {runCount > 0 ? (
            <>
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
              </span>
              <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400">
                {runCount} live
              </span>
            </>
          ) : null}
        </span>
      )}
    </NavLink>
  );
}

function MemberList({
  members,
  agentMap,
  liveCountByAgent,
  activeAgentId,
  activeTab,
}: {
  members: AgentHierarchyMemberSummary[];
  agentMap: Map<string, Agent>;
  liveCountByAgent: Map<string, number>;
  activeAgentId: string | null;
  activeTab: string | null;
}) {
  if (members.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      {members.map((summary) => (
        <SidebarAgentLink
          key={summary.id}
          summary={summary}
          agent={agentMap.get(summary.id) ?? null}
          activeAgentId={activeAgentId}
          activeTab={activeTab}
          runCount={liveCountByAgent.get(summary.id) ?? 0}
        />
      ))}
    </div>
  );
}

function TeamSection({
  team,
  agentMap,
  liveCountByAgent,
  activeAgentId,
  activeTab,
  depth,
}: {
  team: AgentNavigationTeamNode;
  agentMap: Map<string, Agent>;
  liveCountByAgent: Map<string, number>;
  activeAgentId: string | null;
  activeTab: string | null;
  depth: number;
}) {
  if (team.leaders.length === 0 && team.workers.length === 0) return null;
  return (
    <HierarchyFolder label={team.label} depth={depth} defaultOpen={false}>
      {team.leaders.length > 0 ? (
        <HierarchyFolder label="Leads" depth={depth + 1}>
          <MemberList
            members={team.leaders}
            agentMap={agentMap}
            liveCountByAgent={liveCountByAgent}
            activeAgentId={activeAgentId}
            activeTab={activeTab}
          />
        </HierarchyFolder>
      ) : null}
      {team.workers.length > 0 ? (
        <HierarchyFolder label="Workers" depth={depth + 1} defaultOpen={false}>
          <MemberList
            members={team.workers}
            agentMap={agentMap}
            liveCountByAgent={liveCountByAgent}
            activeAgentId={activeAgentId}
            activeTab={activeTab}
          />
        </HierarchyFolder>
      ) : null}
    </HierarchyFolder>
  );
}

function ProjectSection({
  project,
  agentMap,
  liveCountByAgent,
  activeAgentId,
  activeTab,
  depth,
}: {
  project: AgentNavigationProjectNode;
  agentMap: Map<string, Agent>;
  liveCountByAgent: Map<string, number>;
  activeAgentId: string | null;
  activeTab: string | null;
  depth: number;
}) {
  if (project.leaders.length === 0 && project.teams.length === 0 && project.workers.length === 0) {
    return null;
  }

  return (
    <HierarchyFolder label={project.projectName} depth={depth}>
      {project.leaders.length > 0 ? (
        <HierarchyFolder label="Leadership" depth={depth + 1}>
          <MemberList
            members={project.leaders}
            agentMap={agentMap}
            liveCountByAgent={liveCountByAgent}
            activeAgentId={activeAgentId}
            activeTab={activeTab}
          />
        </HierarchyFolder>
      ) : null}
      {project.teams.map((team) => (
        <TeamSection
          key={`${project.projectId}:${team.key}`}
          team={team}
          agentMap={agentMap}
          liveCountByAgent={liveCountByAgent}
          activeAgentId={activeAgentId}
          activeTab={activeTab}
          depth={depth + 1}
        />
      ))}
      {project.workers.length > 0 ? (
        <HierarchyFolder label="Workers" depth={depth + 1} defaultOpen={false}>
          <MemberList
            members={project.workers}
            agentMap={agentMap}
            liveCountByAgent={liveCountByAgent}
            activeAgentId={activeAgentId}
            activeTab={activeTab}
          />
        </HierarchyFolder>
      ) : null}
    </HierarchyFolder>
  );
}

function ClusterSection({
  cluster,
  agentMap,
  liveCountByAgent,
  activeAgentId,
  activeTab,
  depth,
}: {
  cluster: AgentNavigationClusterNode;
  agentMap: Map<string, Agent>;
  liveCountByAgent: Map<string, number>;
  activeAgentId: string | null;
  activeTab: string | null;
  depth: number;
}) {
  if ((cluster.portfolioDirector == null) && cluster.projects.length === 0) {
    return null;
  }

  return (
    <HierarchyFolder label={cluster.name} depth={depth}>
      {cluster.portfolioDirector ? (
        <HierarchyFolder label="Portfolio Director" depth={depth + 1}>
          <MemberList
            members={[cluster.portfolioDirector]}
            agentMap={agentMap}
            liveCountByAgent={liveCountByAgent}
            activeAgentId={activeAgentId}
            activeTab={activeTab}
          />
        </HierarchyFolder>
      ) : null}
      {cluster.projects.map((project) => (
        <ProjectSection
          key={`${cluster.clusterId}:${project.projectId}`}
          project={project}
          agentMap={agentMap}
          liveCountByAgent={liveCountByAgent}
          activeAgentId={activeAgentId}
          activeTab={activeTab}
          depth={depth + 1}
        />
      ))}
    </HierarchyFolder>
  );
}

function DepartmentSection({
  department,
  agentMap,
  liveCountByAgent,
  activeAgentId,
  activeTab,
  depth,
}: {
  department: AgentNavigationDepartmentNode;
  agentMap: Map<string, Agent>;
  liveCountByAgent: Map<string, number>;
  activeAgentId: string | null;
  activeTab: string | null;
  depth: number;
}) {
  const clusters = department.clusters ?? [];
  const hasClusterTree = clusters.length > 0;
  if (department.leaders.length === 0 && clusters.length === 0 && department.projects.length === 0) return null;

  return (
    <HierarchyFolder label={department.name} depth={depth}>
      {department.leaders.length > 0 ? (
        <HierarchyFolder label="Leads" depth={depth + 1}>
          <MemberList
            members={department.leaders}
            agentMap={agentMap}
            liveCountByAgent={liveCountByAgent}
            activeAgentId={activeAgentId}
            activeTab={activeTab}
          />
        </HierarchyFolder>
      ) : null}
      {hasClusterTree
        ? clusters.map((cluster) => (
            <ClusterSection
              key={`${department.key}:${cluster.clusterId}`}
              cluster={cluster}
              agentMap={agentMap}
              liveCountByAgent={liveCountByAgent}
              activeAgentId={activeAgentId}
              activeTab={activeTab}
              depth={depth + 1}
            />
          ))
        : department.projects.map((project) => (
            <ProjectSection
              key={`${department.key}:${project.projectId}`}
              project={project}
              agentMap={agentMap}
              liveCountByAgent={liveCountByAgent}
              activeAgentId={activeAgentId}
              activeTab={activeTab}
              depth={depth + 1}
            />
          ))}
    </HierarchyFolder>
  );
}

function LayoutToggle({
  layout,
  onChange,
}: {
  layout: AgentNavigationLayout;
  onChange: (layout: AgentNavigationLayout) => void;
}) {
  return (
    <div className="mx-3 mb-2 flex rounded-md border border-border/70 bg-background/70 p-0.5">
      {(["department", "project"] as const).map((value) => (
        <Button
          key={value}
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            "h-6 flex-1 px-2 text-[11px] capitalize",
            layout === value && "bg-accent text-foreground",
          )}
          onClick={() => onChange(value)}
        >
          {value}
        </Button>
      ))}
    </div>
  );
}

function NavigationContent({
  navigation,
  agentMap,
  liveCountByAgent,
  activeAgentId,
  activeTab,
}: {
  navigation: CompanyAgentNavigation;
  agentMap: Map<string, Agent>;
  liveCountByAgent: Map<string, number>;
  activeAgentId: string | null;
  activeTab: string | null;
}) {
  return (
    <div className="mt-0.5 flex flex-col gap-1">
      {navigation.executives.length > 0 ? (
        <HierarchyFolder label="Executives">
          <MemberList
            members={navigation.executives}
            agentMap={agentMap}
            liveCountByAgent={liveCountByAgent}
            activeAgentId={activeAgentId}
            activeTab={activeTab}
          />
        </HierarchyFolder>
      ) : null}

      {navigation.layout === "department" ? (
        navigation.departments.length > 0 ? (
          <HierarchyFolder label="Departments">
            {navigation.departments.map((department) => (
              <DepartmentSection
                key={`${department.key}:${department.name}`}
                department={department}
                agentMap={agentMap}
                liveCountByAgent={liveCountByAgent}
                activeAgentId={activeAgentId}
                activeTab={activeTab}
                depth={1}
              />
            ))}
          </HierarchyFolder>
        ) : null
      ) : (navigation.portfolioClusters?.length ?? 0) > 0 ? (
        <HierarchyFolder label="Portfolio Clusters">
          {(navigation.portfolioClusters ?? []).map((cluster) => (
            <ClusterSection
              key={cluster.clusterId}
              cluster={cluster}
              agentMap={agentMap}
              liveCountByAgent={liveCountByAgent}
              activeAgentId={activeAgentId}
              activeTab={activeTab}
              depth={1}
            />
          ))}
        </HierarchyFolder>
      ) : navigation.projectPods.length > 0 ? (
        <HierarchyFolder label="Project Pods">
          {navigation.projectPods.map((project) => (
            <ProjectSection
              key={project.projectId}
              project={project}
              agentMap={agentMap}
              liveCountByAgent={liveCountByAgent}
              activeAgentId={activeAgentId}
              activeTab={activeTab}
              depth={1}
            />
          ))}
        </HierarchyFolder>
      ) : null}

      {navigation.sharedServices.length > 0 ? (
        <HierarchyFolder label="Shared Services" defaultOpen={false}>
          {navigation.sharedServices.map((department) => (
            <DepartmentSection
              key={`${department.key}:${department.name}`}
              department={department}
              agentMap={agentMap}
              liveCountByAgent={liveCountByAgent}
              activeAgentId={activeAgentId}
              activeTab={activeTab}
              depth={1}
            />
          ))}
        </HierarchyFolder>
      ) : null}

      {navigation.unassigned.length > 0 ? (
        <HierarchyFolder label="Unassigned" defaultOpen={false}>
          <MemberList
            members={navigation.unassigned}
            agentMap={agentMap}
            liveCountByAgent={liveCountByAgent}
            activeAgentId={activeAgentId}
            activeTab={activeTab}
          />
        </HierarchyFolder>
      ) : null}
    </div>
  );
}

export function SidebarAgents() {
  const [open, setOpen] = useState(true);
  const { selectedCompanyId } = useCompany();
  const { openNewAgent } = useDialog();
  const location = useLocation();

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;

  const [layout, setLayout] = useState<AgentNavigationLayout>("department");

  useEffect(() => {
    if (!selectedCompanyId) return;
    setLayout(getStoredAgentLayout(selectedCompanyId, currentUserId));
  }, [selectedCompanyId, currentUserId]);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: navigation } = useQuery({
    queryKey: queryKeys.agents.navigation(selectedCompanyId!, layout),
    queryFn: () => agentsApi.navigation(selectedCompanyId!, layout),
    enabled: !!selectedCompanyId,
  });
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });

  const agentMap = useMemo(() => {
    const next = new Map<string, Agent>();
    for (const agent of agents ?? []) {
      if (agent.status !== "terminated") {
        next.set(agent.id, agent);
      }
    }
    return next;
  }, [agents]);

  const liveCountByAgent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const run of liveRuns ?? []) {
      counts.set(run.agentId, (counts.get(run.agentId) ?? 0) + 1);
    }
    return counts;
  }, [liveRuns]);

  const agentMatch = location.pathname.match(/^\/(?:[^/]+\/)?agents\/([^/]+)(?:\/([^/]+))?/);
  const activeAgentId = agentMatch?.[1] ?? null;
  const activeTab = agentMatch?.[2] ?? null;

  function updateLayout(next: AgentNavigationLayout) {
    if (!selectedCompanyId) return;
    setLayout(next);
    setStoredAgentLayout(selectedCompanyId, next, currentUserId);
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="group">
        <div className="flex items-center px-3 py-1.5">
          <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1">
            <ChevronRight
              className={cn(
                "h-3 w-3 text-muted-foreground/60 transition-transform opacity-0 group-hover:opacity-100",
                open && "rotate-90",
              )}
            />
            <span className="font-mono text-[10px] font-medium uppercase tracking-widest text-muted-foreground/60">
              Agents
            </span>
          </CollapsibleTrigger>
          <button
            onClick={(e) => {
              e.stopPropagation();
              openNewAgent();
            }}
            className="flex h-4 w-4 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-accent/50 hover:text-foreground"
            aria-label="New agent"
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>
      </div>

      <CollapsibleContent>
        {selectedCompanyId ? <LayoutToggle layout={layout} onChange={updateLayout} /> : null}
        {navigation ? (
          <NavigationContent
            navigation={navigation}
            agentMap={agentMap}
            liveCountByAgent={liveCountByAgent}
            activeAgentId={activeAgentId}
            activeTab={activeTab}
          />
        ) : (
          <div className="px-3 py-2 text-xs text-muted-foreground">Loading agents…</div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

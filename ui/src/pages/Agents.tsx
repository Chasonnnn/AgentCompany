import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import {
  AGENT_DEPARTMENT_LABELS,
  AGENT_ROLE_LABELS,
  type Agent,
  type AgentHierarchyMemberSummary,
  type AgentNavigationClusterNode,
  type AgentNavigationDepartmentNode,
  type AgentNavigationProjectNode,
  type AgentNavigationTeamNode,
  type CompanyAgentNavigation,
} from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
import { queryKeys } from "../lib/queryKeys";
import {
  buildSharedServiceLeadDepartmentsFromNavigation,
  buildSharedSpecialistGroupsFromNavigation,
  countSharedSpecialists,
} from "../lib/shared-specialists";
import { StatusBadge } from "../components/StatusBadge";
import { agentStatusDot, agentStatusDotDefault } from "../lib/status-colors";
import { EntityRow } from "../components/EntityRow";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { relativeTime, cn, agentRouteRef, agentUrl } from "../lib/utils";
import { PageTabBar } from "../components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Bot, Plus, List, GitBranch, SlidersHorizontal } from "lucide-react";
import { getAdapterLabel } from "../adapters/adapter-display-registry";

type FilterTab = "all" | "active" | "paused" | "error";

function matchesFilter(status: string, tab: FilterTab, showTerminated: boolean): boolean {
  if (status === "terminated") return showTerminated;
  if (tab === "all") return true;
  if (tab === "active") return status === "active" || status === "running" || status === "idle";
  if (tab === "paused") return status === "paused";
  if (tab === "error") return status === "error";
  return true;
}

function filterAgents(agents: Agent[], tab: FilterTab, showTerminated: boolean): Agent[] {
  return agents
    .filter((agent) => matchesFilter(agent.status, tab, showTerminated))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function filterMembers<T extends AgentHierarchyMemberSummary>(
  members: T[],
  tab: FilterTab,
  showTerminated: boolean,
) {
  return members
    .filter((member) => matchesFilter(member.status, tab, showTerminated))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function filterTeam(
  team: AgentNavigationTeamNode,
  tab: FilterTab,
  showTerminated: boolean,
): AgentNavigationTeamNode | null {
  const leaders = filterMembers(team.leaders, tab, showTerminated);
  const workers = filterMembers(team.workers, tab, showTerminated);
  if (leaders.length === 0 && workers.length === 0) return null;
  return { ...team, leaders, workers };
}

function filterProject(
  project: AgentNavigationProjectNode,
  tab: FilterTab,
  showTerminated: boolean,
): AgentNavigationProjectNode | null {
  const leaders = filterMembers(project.leaders, tab, showTerminated);
  const teams = project.teams
    .map((team) => filterTeam(team, tab, showTerminated))
    .filter((team): team is AgentNavigationTeamNode => Boolean(team));
  const workers = filterMembers(project.workers, tab, showTerminated);
  if (leaders.length === 0 && teams.length === 0 && workers.length === 0) return null;
  return { ...project, leaders, teams, workers };
}

function filterCluster(
  cluster: AgentNavigationClusterNode,
  tab: FilterTab,
  showTerminated: boolean,
): AgentNavigationClusterNode | null {
  const portfolioDirector =
    cluster.portfolioDirector && matchesFilter(cluster.portfolioDirector.status, tab, showTerminated)
      ? cluster.portfolioDirector
      : null;
  const projects = cluster.projects
    .map((project) => filterProject(project, tab, showTerminated))
    .filter((project): project is AgentNavigationProjectNode => Boolean(project));
  if (!portfolioDirector && projects.length === 0) return null;
  return { ...cluster, portfolioDirector, projects };
}

function filterDepartment(
  department: AgentNavigationDepartmentNode,
  tab: FilterTab,
  showTerminated: boolean,
): AgentNavigationDepartmentNode | null {
  const leaders = filterMembers(department.leaders, tab, showTerminated);
  const clusters = (department.clusters ?? [])
    .map((cluster) => filterCluster(cluster, tab, showTerminated))
    .filter((cluster): cluster is AgentNavigationClusterNode => Boolean(cluster));
  const projects = department.projects
    .map((project) => filterProject(project, tab, showTerminated))
    .filter((project): project is AgentNavigationProjectNode => Boolean(project));
  if (leaders.length === 0 && clusters.length === 0 && projects.length === 0) return null;
  return { ...department, leaders, clusters, projects };
}

function filterNavigation(
  navigation: CompanyAgentNavigation,
  tab: FilterTab,
  showTerminated: boolean,
): CompanyAgentNavigation {
  return {
    ...navigation,
    executives: filterMembers(navigation.executives, tab, showTerminated),
    departments: navigation.departments
      .map((department) => filterDepartment(department, tab, showTerminated))
      .filter((department): department is AgentNavigationDepartmentNode => Boolean(department)),
    portfolioClusters: (navigation.portfolioClusters ?? [])
      .map((cluster) => filterCluster(cluster, tab, showTerminated))
      .filter((cluster): cluster is AgentNavigationClusterNode => Boolean(cluster)),
    projectPods: navigation.projectPods
      .map((project) => filterProject(project, tab, showTerminated))
      .filter((project): project is AgentNavigationProjectNode => Boolean(project)),
    sharedServices: navigation.sharedServices
      .map((department) => filterDepartment(department, tab, showTerminated))
      .filter((department): department is AgentNavigationDepartmentNode => Boolean(department)),
    unassigned: filterMembers(navigation.unassigned, tab, showTerminated),
  };
}

function navigationCount(
  navigation: CompanyAgentNavigation,
  sharedSpecialistsCount: number,
  sharedServiceDepartments: AgentNavigationDepartmentNode[],
) {
  const ids = new Set<string>();
  for (const agent of navigation.executives) ids.add(agent.id);
  for (const department of navigation.departments) {
    for (const leader of department.leaders) ids.add(leader.id);
    for (const cluster of department.clusters ?? []) {
      if (cluster.portfolioDirector) ids.add(cluster.portfolioDirector.id);
      for (const project of cluster.projects) {
        for (const leader of project.leaders) ids.add(leader.id);
        for (const team of project.teams) {
          for (const leader of team.leaders) ids.add(leader.id);
          for (const worker of team.workers) ids.add(worker.id);
        }
        for (const worker of project.workers) ids.add(worker.id);
      }
    }
    for (const project of department.projects) {
      for (const leader of project.leaders) ids.add(leader.id);
      for (const team of project.teams) {
        for (const leader of team.leaders) ids.add(leader.id);
        for (const worker of team.workers) ids.add(worker.id);
      }
      for (const worker of project.workers) ids.add(worker.id);
    }
  }
  for (const department of sharedServiceDepartments) {
    for (const leader of department.leaders) ids.add(leader.id);
    for (const cluster of department.clusters ?? []) {
      if (cluster.portfolioDirector) ids.add(cluster.portfolioDirector.id);
      for (const project of cluster.projects) {
        for (const leader of project.leaders) ids.add(leader.id);
        for (const team of project.teams) {
          for (const leader of team.leaders) ids.add(leader.id);
          for (const worker of team.workers) ids.add(worker.id);
        }
        for (const worker of project.workers) ids.add(worker.id);
      }
    }
    for (const project of department.projects) {
      for (const leader of project.leaders) ids.add(leader.id);
      for (const team of project.teams) {
        for (const leader of team.leaders) ids.add(leader.id);
        for (const worker of team.workers) ids.add(worker.id);
      }
      for (const worker of project.workers) ids.add(worker.id);
    }
  }
  for (const agent of navigation.unassigned) ids.add(agent.id);
  return ids.size + sharedSpecialistsCount;
}

function levelLabel(level: string) {
  if (level === "executive") return "Executive";
  if (level === "director") return "Director";
  return "Staff";
}

function NavigationMemberRow({
  member,
  agent,
  liveRunByAgent,
}: {
  member: AgentHierarchyMemberSummary;
  agent: Agent | null;
  liveRunByAgent: Map<string, { runId: string; liveCount: number }>;
}) {
  const resolvedAgent = agent ?? ({
    ...member,
    companyId: "",
    capabilities: null,
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as Agent);
  return (
    <EntityRow
      title={member.name}
      subtitle={`${AGENT_ROLE_LABELS[member.role] ?? member.role}${member.title ? ` - ${member.title}` : ""}`}
      to={agentUrl(resolvedAgent)}
      leading={
        <span className="relative flex h-2.5 w-2.5">
          <span
            className={`absolute inline-flex h-full w-full rounded-full ${agentStatusDot[member.status] ?? agentStatusDotDefault}`}
          />
        </span>
      }
      trailing={
        <div className="flex items-center gap-3">
          {liveRunByAgent.has(member.id) ? (
            <LiveRunIndicator
              agentRef={agentRouteRef(resolvedAgent)}
              runId={liveRunByAgent.get(member.id)!.runId}
              liveCount={liveRunByAgent.get(member.id)!.liveCount}
            />
          ) : null}
          <span className="hidden min-w-24 text-right text-[11px] text-muted-foreground sm:inline">
            {levelLabel(member.orgLevel)}
          </span>
          <span className="hidden min-w-28 text-right text-[11px] text-muted-foreground sm:inline">
            {member.departmentKey === "custom"
              ? member.departmentName ?? "Custom"
              : AGENT_DEPARTMENT_LABELS[member.departmentKey]}
          </span>
          {agent ? (
            <>
              <span className="hidden w-16 text-right font-mono text-xs text-muted-foreground sm:inline">
                {getAdapterLabel(agent.adapterType)}
              </span>
              <span className="hidden w-16 text-right text-xs text-muted-foreground sm:inline">
                {agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : "—"}
              </span>
            </>
          ) : null}
          <span className="w-20 flex justify-end">
            <StatusBadge status={member.status} />
          </span>
        </div>
      }
    />
  );
}

function MemberBlock({
  label,
  members,
  agentMap,
  liveRunByAgent,
}: {
  label: string;
  members: AgentHierarchyMemberSummary[];
  agentMap: Map<string, Agent>;
  liveRunByAgent: Map<string, { runId: string; liveCount: number }>;
}) {
  if (members.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </div>
      <div className="border border-border">
        {members.map((member) => (
          <NavigationMemberRow
            key={member.id}
            member={member}
            agent={agentMap.get(member.id) ?? null}
            liveRunByAgent={liveRunByAgent}
          />
        ))}
      </div>
    </div>
  );
}

function TeamBlock({
  team,
  agentMap,
  liveRunByAgent,
}: {
  team: AgentNavigationTeamNode;
  agentMap: Map<string, Agent>;
  liveRunByAgent: Map<string, { runId: string; liveCount: number }>;
}) {
  return (
    <section className="space-y-3 rounded-xl border border-border/70 bg-card/40 p-4">
      <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
        {team.label}
      </div>
      <MemberBlock label="Leads" members={team.leaders} agentMap={agentMap} liveRunByAgent={liveRunByAgent} />
      <MemberBlock label="Workers" members={team.workers} agentMap={agentMap} liveRunByAgent={liveRunByAgent} />
    </section>
  );
}

function ProjectBlock({
  project,
  agentMap,
  liveRunByAgent,
}: {
  project: AgentNavigationProjectNode;
  agentMap: Map<string, Agent>;
  liveRunByAgent: Map<string, { runId: string; liveCount: number }>;
}) {
  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            Project
          </div>
          <div className="text-lg font-semibold">{project.projectName}</div>
        </div>
      </div>
      <MemberBlock label="Leadership" members={project.leaders} agentMap={agentMap} liveRunByAgent={liveRunByAgent} />
      {project.teams.map((team) => (
        <TeamBlock
          key={`${project.projectId}:${team.key}`}
          team={team}
          agentMap={agentMap}
          liveRunByAgent={liveRunByAgent}
        />
      ))}
      <MemberBlock label="Workers" members={project.workers} agentMap={agentMap} liveRunByAgent={liveRunByAgent} />
    </section>
  );
}

function ClusterBlock({
  cluster,
  agentMap,
  liveRunByAgent,
}: {
  cluster: AgentNavigationClusterNode;
  agentMap: Map<string, Agent>;
  liveRunByAgent: Map<string, { runId: string; liveCount: number }>;
}) {
  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-4">
      <div>
        <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Portfolio Cluster
        </div>
        <div className="text-lg font-semibold">{cluster.name}</div>
        {cluster.summary ? (
          <p className="mt-1 text-sm text-muted-foreground">{cluster.summary}</p>
        ) : null}
      </div>
      {cluster.portfolioDirector ? (
        <MemberBlock
          label="Portfolio Director"
          members={[cluster.portfolioDirector]}
          agentMap={agentMap}
          liveRunByAgent={liveRunByAgent}
        />
      ) : null}
      {cluster.projects.map((project) => (
        <ProjectBlock
          key={`${cluster.clusterId}:${project.projectId}`}
          project={project}
          agentMap={agentMap}
          liveRunByAgent={liveRunByAgent}
        />
      ))}
    </section>
  );
}

function DepartmentBlock({
  department,
  agentMap,
  liveRunByAgent,
  membersLabel = "Leads",
}: {
  department: AgentNavigationDepartmentNode;
  agentMap: Map<string, Agent>;
  liveRunByAgent: Map<string, { runId: string; liveCount: number }>;
  membersLabel?: string;
}) {
  return (
    <section className="space-y-4">
      <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
        {department.name}
      </div>
      <MemberBlock
        label={membersLabel}
        members={department.leaders}
        agentMap={agentMap}
        liveRunByAgent={liveRunByAgent}
      />
      {(department.clusters?.length ?? 0) > 0
        ? (department.clusters ?? []).map((cluster) => (
            <ClusterBlock
              key={`${department.key}:${cluster.clusterId}`}
              cluster={cluster}
              agentMap={agentMap}
              liveRunByAgent={liveRunByAgent}
            />
          ))
        : department.projects.map((project) => (
            <ProjectBlock
              key={`${department.key}:${project.projectId}`}
              project={project}
              agentMap={agentMap}
              liveRunByAgent={liveRunByAgent}
            />
          ))}
    </section>
  );
}

export function Agents() {
  const { selectedCompanyId } = useCompany();
  const { openNewAgent } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const location = useLocation();
  const { isMobile } = useSidebar();
  const pathSegment = location.pathname.split("/").pop() ?? "all";
  const tab: FilterTab =
    pathSegment === "all" || pathSegment === "active" || pathSegment === "paused" || pathSegment === "error"
      ? pathSegment
      : "all";
  const [view, setView] = useState<"list" | "tree">("tree");
  const forceListView = isMobile;
  const effectiveView = forceListView ? "list" : view;
  const [showTerminated, setShowTerminated] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const { data: agents, isLoading, error } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: navigation } = useQuery({
    queryKey: queryKeys.agents.navigation(selectedCompanyId!, "department"),
    queryFn: () => agentsApi.navigation(selectedCompanyId!, "department"),
    enabled: !!selectedCompanyId && effectiveView === "tree",
  });

  const { data: runs } = useQuery({
    queryKey: queryKeys.heartbeats(selectedCompanyId!),
    queryFn: () => heartbeatsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  const liveRunByAgent = useMemo(() => {
    const map = new Map<string, { runId: string; liveCount: number }>();
    for (const run of runs ?? []) {
      if (run.status !== "running" && run.status !== "queued") continue;
      const existing = map.get(run.agentId);
      if (existing) {
        existing.liveCount += 1;
        continue;
      }
      map.set(run.agentId, { runId: run.id, liveCount: 1 });
    }
    return map;
  }, [runs]);

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agents ?? []) map.set(agent.id, agent);
    return map;
  }, [agents]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Agents" }]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Bot} message="Select a company to view agents." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const filteredAgents = filterAgents(agents ?? [], tab, showTerminated);
  const filteredNavigation = navigation ? filterNavigation(navigation, tab, showTerminated) : null;
  const sharedSpecialists = filteredNavigation
    ? buildSharedSpecialistGroupsFromNavigation(filteredNavigation)
    : [];
  const sharedServiceDepartments = filteredNavigation
    ? buildSharedServiceLeadDepartmentsFromNavigation(filteredNavigation)
    : [];
  const filteredNavigationCount = filteredNavigation
    ? navigationCount(filteredNavigation, countSharedSpecialists(sharedSpecialists), sharedServiceDepartments)
    : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={tab} onValueChange={(value) => navigate(`/agents/${value}`)}>
          <PageTabBar
            items={[
              { value: "all", label: "All" },
              { value: "active", label: "Active" },
              { value: "paused", label: "Paused" },
              { value: "error", label: "Error" },
            ]}
          />
        </Tabs>
        <div className="flex items-center gap-2">
          <div className="relative">
            <button
              className={cn(
                "flex items-center gap-1.5 border border-border px-2 py-1.5 text-xs transition-colors",
                filtersOpen || showTerminated
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50",
              )}
              onClick={() => setFiltersOpen((current) => !current)}
            >
              <SlidersHorizontal className="h-3 w-3" />
              Filters
              {showTerminated ? (
                <span className="ml-0.5 rounded bg-foreground/10 px-1 text-[10px]">1</span>
              ) : null}
            </button>
            {filtersOpen ? (
              <div className="absolute right-0 top-full z-50 mt-1 w-48 border border-border bg-popover p-1 shadow-md">
                <button
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent/50"
                  onClick={() => setShowTerminated((current) => !current)}
                >
                  <span
                    className={cn(
                      "flex h-3.5 w-3.5 items-center justify-center rounded-sm border border-border",
                      showTerminated && "bg-foreground",
                    )}
                  >
                    {showTerminated ? (
                      <span className="text-[10px] leading-none text-background">&#10003;</span>
                    ) : null}
                  </span>
                  Show terminated
                </button>
              </div>
            ) : null}
          </div>

          {!forceListView ? (
            <div className="flex items-center border border-border">
              <button
                className={cn(
                  "p-1.5 transition-colors",
                  effectiveView === "list"
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/50",
                )}
                onClick={() => setView("list")}
              >
                <List className="h-3.5 w-3.5" />
              </button>
              <button
                className={cn(
                  "p-1.5 transition-colors",
                  effectiveView === "tree"
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/50",
                )}
                onClick={() => setView("tree")}
              >
                <GitBranch className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : null}

          <Button size="sm" variant="outline" onClick={openNewAgent}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            New Agent
          </Button>
        </div>
      </div>

      {effectiveView === "list" && filteredAgents.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {filteredAgents.length} agent{filteredAgents.length !== 1 ? "s" : ""}
        </p>
      ) : null}
      {effectiveView === "tree" && filteredNavigation ? (
        <p className="text-xs text-muted-foreground">
          {filteredNavigationCount} agent{filteredNavigationCount !== 1 ? "s" : ""} visible in browse tree
        </p>
      ) : null}

      {error ? <p className="text-sm text-destructive">{error.message}</p> : null}

      {agents && agents.length === 0 ? (
        <EmptyState
          icon={Bot}
          message="Create your first agent to get started."
          action="New Agent"
          onAction={openNewAgent}
        />
      ) : null}

      {effectiveView === "list" && filteredAgents.length > 0 ? (
        <div className="border border-border">
          {filteredAgents.map((agent) => (
            <EntityRow
              key={agent.id}
              title={agent.name}
              subtitle={`${AGENT_ROLE_LABELS[agent.role] ?? agent.role}${agent.title ? ` - ${agent.title}` : ""}`}
              to={agentUrl(agent)}
              className={agent.pausedAt && tab !== "paused" ? "opacity-50" : ""}
              leading={
                <span className="relative flex h-2.5 w-2.5">
                  <span
                    className={`absolute inline-flex h-full w-full rounded-full ${agentStatusDot[agent.status] ?? agentStatusDotDefault}`}
                  />
                </span>
              }
              trailing={
                <div className="flex items-center gap-3">
                  {liveRunByAgent.has(agent.id) ? (
                    <LiveRunIndicator
                      agentRef={agentRouteRef(agent)}
                      runId={liveRunByAgent.get(agent.id)!.runId}
                      liveCount={liveRunByAgent.get(agent.id)!.liveCount}
                    />
                  ) : null}
                  <span className="hidden min-w-24 text-right text-[11px] text-muted-foreground sm:inline">
                    {levelLabel(agent.orgLevel)}
                  </span>
                  <span className="hidden min-w-28 text-right text-[11px] text-muted-foreground sm:inline">
                    {agent.departmentKey === "custom"
                      ? agent.departmentName ?? "Custom"
                      : AGENT_DEPARTMENT_LABELS[agent.departmentKey]}
                  </span>
                  <span className="hidden w-16 text-right font-mono text-xs text-muted-foreground sm:inline">
                    {getAdapterLabel(agent.adapterType)}
                  </span>
                  <span className="hidden w-16 text-right text-xs text-muted-foreground sm:inline">
                    {agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : "—"}
                  </span>
                  <span className="w-20 flex justify-end">
                    <StatusBadge status={agent.status} />
                  </span>
                </div>
              }
            />
          ))}
        </div>
      ) : null}

      {effectiveView === "list" && agents && agents.length > 0 && filteredAgents.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No agents match the selected filter.
        </p>
      ) : null}

      {effectiveView === "tree" && filteredNavigation && filteredNavigationCount > 0 ? (
        <div className="space-y-6">
          {filteredNavigation.executives.length > 0 ? (
            <section className="space-y-3">
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                Executives
              </div>
              <MemberBlock
                label="Executive Office"
                members={filteredNavigation.executives}
                agentMap={agentMap}
                liveRunByAgent={liveRunByAgent}
              />
            </section>
          ) : null}

          {filteredNavigation.departments.map((department) => (
            <DepartmentBlock
              key={`${department.key}:${department.name}`}
              department={department}
              agentMap={agentMap}
              liveRunByAgent={liveRunByAgent}
            />
          ))}

          {sharedSpecialists.length > 0 ? (
            <section className="space-y-4">
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                Shared Specialists
              </div>
              {sharedSpecialists.map((group) => (
                <MemberBlock
                  key={group.key}
                  label={group.label}
                  members={group.members}
                  agentMap={agentMap}
                  liveRunByAgent={liveRunByAgent}
                />
              ))}
            </section>
          ) : null}

          {sharedServiceDepartments.length > 0 ? (
            <section className="space-y-4">
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                Shared Services
              </div>
              {sharedServiceDepartments.map((department) => (
                <DepartmentBlock
                  key={`${department.key}:${department.name}`}
                  department={department}
                  agentMap={agentMap}
                  liveRunByAgent={liveRunByAgent}
                />
              ))}
            </section>
          ) : null}

          {filteredNavigation.unassigned.length > 0 ? (
            <section className="space-y-3">
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                Needs Scope
              </div>
              <MemberBlock
                label="Not yet placed"
                members={filteredNavigation.unassigned}
                agentMap={agentMap}
                liveRunByAgent={liveRunByAgent}
              />
            </section>
          ) : null}
        </div>
      ) : null}

      {effectiveView === "tree" && filteredNavigation && filteredNavigationCount === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No agents match the selected filter.
        </p>
      ) : null}
    </div>
  );
}

function LiveRunIndicator({
  agentRef,
  runId,
  liveCount,
}: {
  agentRef: string;
  runId: string;
  liveCount: number;
}) {
  return (
    <Link
      to={`/agents/${agentRef}/runs/${runId}`}
      className="flex items-center gap-1.5 rounded-full bg-blue-500/10 px-2 py-0.5 no-underline transition-colors hover:bg-blue-500/20"
      onClick={(event) => event.stopPropagation()}
    >
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-blue-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
      </span>
      <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400">
        Live{liveCount > 1 ? ` (${liveCount})` : ""}
      </span>
    </Link>
  );
}

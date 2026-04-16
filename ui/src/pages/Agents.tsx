import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AGENT_DEPARTMENT_LABELS,
  AGENT_ROLE_LABELS,
  type Agent,
  type AccountabilityAgentSummary,
  type AccountabilityProjectNode,
  type AgentHierarchyMemberSummary,
  type AgentNavigationClusterNode,
  type AgentNavigationDepartmentNode,
  type AgentNavigationLayout,
  type AgentNavigationProjectNode,
  type AgentNavigationTeamNode,
  type CompanyAgentAccountability,
  type CompanyOrgSimplificationReport,
  type CompanyAgentNavigation,
  type OperatingHierarchyDepartmentSummary,
  type OperatingHierarchyProjectSummary,
  type OrgSimplificationCandidate,
} from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
import { getStoredAgentLayout, setStoredAgentLayout, type AgentLayoutMode } from "../lib/agent-layout";
import { queryKeys } from "../lib/queryKeys";
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
  const executiveSponsor =
    cluster.executiveSponsor && matchesFilter(cluster.executiveSponsor.status, tab, showTerminated)
      ? cluster.executiveSponsor
      : null;
  const portfolioDirector =
    cluster.portfolioDirector && matchesFilter(cluster.portfolioDirector.status, tab, showTerminated)
      ? cluster.portfolioDirector
      : null;
  const projects = cluster.projects
    .map((project) => filterProject(project, tab, showTerminated))
    .filter((project): project is AgentNavigationProjectNode => Boolean(project));
  if (!executiveSponsor && !portfolioDirector && projects.length === 0) return null;
  return { ...cluster, executiveSponsor, portfolioDirector, projects };
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

function navigationCount(navigation: CompanyAgentNavigation) {
  const ids = new Set<string>();
  for (const agent of navigation.executives) ids.add(agent.id);
  for (const department of navigation.departments) {
    for (const leader of department.leaders) ids.add(leader.id);
    for (const cluster of department.clusters ?? []) {
      if (cluster.executiveSponsor) ids.add(cluster.executiveSponsor.id);
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
  for (const department of navigation.sharedServices) {
    for (const leader of department.leaders) ids.add(leader.id);
    for (const cluster of department.clusters ?? []) {
      if (cluster.executiveSponsor) ids.add(cluster.executiveSponsor.id);
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
  for (const cluster of navigation.portfolioClusters ?? []) {
    if (cluster.executiveSponsor) ids.add(cluster.executiveSponsor.id);
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
  for (const project of navigation.projectPods) {
    for (const leader of project.leaders) ids.add(leader.id);
    for (const team of project.teams) {
      for (const leader of team.leaders) ids.add(leader.id);
      for (const worker of team.workers) ids.add(worker.id);
    }
    for (const worker of project.workers) ids.add(worker.id);
  }
  for (const agent of navigation.unassigned) ids.add(agent.id);
  return ids.size;
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
}: {
  department: AgentNavigationDepartmentNode;
  agentMap: Map<string, Agent>;
  liveRunByAgent: Map<string, { runId: string; liveCount: number }>;
}) {
  return (
    <section className="space-y-4">
      <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
        {department.name}
      </div>
      <MemberBlock label="Leads" members={department.leaders} agentMap={agentMap} liveRunByAgent={liveRunByAgent} />
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

function OperatingProjectBlock({
  project,
  agentMap,
  liveRunByAgent,
}: {
  project: OperatingHierarchyProjectSummary;
  agentMap: Map<string, Agent>;
  liveRunByAgent: Map<string, { runId: string; liveCount: number }>;
}) {
  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div>
        <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Project
        </div>
        <div className="text-lg font-semibold">{project.projectName}</div>
      </div>
      <MemberBlock label="Leadership" members={project.leadership} agentMap={agentMap} liveRunByAgent={liveRunByAgent} />
      <MemberBlock label="Workers" members={project.workers} agentMap={agentMap} liveRunByAgent={liveRunByAgent} />
      <MemberBlock label="Consultants" members={project.consultants} agentMap={agentMap} liveRunByAgent={liveRunByAgent} />
    </section>
  );
}

function OperatingDepartmentBlock({
  department,
  agentMap,
  liveRunByAgent,
}: {
  department: OperatingHierarchyDepartmentSummary;
  agentMap: Map<string, Agent>;
  liveRunByAgent: Map<string, { runId: string; liveCount: number }>;
}) {
  return (
    <section className="space-y-4">
      <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
        {department.name}
      </div>
      <MemberBlock label="Leads" members={department.leaders} agentMap={agentMap} liveRunByAgent={liveRunByAgent} />
      {department.projects.map((project) => (
        <OperatingProjectBlock
          key={`${department.key}:${project.projectId}`}
          project={project}
          agentMap={agentMap}
          liveRunByAgent={liveRunByAgent}
        />
      ))}
    </section>
  );
}

function filterAccountability(
  accountability: CompanyAgentAccountability,
  tab: FilterTab,
  showTerminated: boolean,
): CompanyAgentAccountability {
  const filterOwners = (owners: AccountabilityAgentSummary[]) =>
    owners.filter((owner) => matchesFilter(owner.status, tab, showTerminated));
  const filterOperatingProject = (
    project: OperatingHierarchyProjectSummary,
  ): OperatingHierarchyProjectSummary | null => {
    const leadership = filterMembers(project.leadership, tab, showTerminated);
    const workers = filterMembers(project.workers, tab, showTerminated);
    const consultants = filterMembers(project.consultants, tab, showTerminated);
    if (leadership.length === 0 && workers.length === 0 && consultants.length === 0) return null;
    return { ...project, leadership, workers, consultants };
  };
  const filterOperatingDepartment = (
    department: OperatingHierarchyDepartmentSummary,
  ): OperatingHierarchyDepartmentSummary | null => {
    const leaders = filterMembers(department.leaders, tab, showTerminated);
    const projects = department.projects
      .map((project) => filterOperatingProject(project))
      .filter((project): project is OperatingHierarchyProjectSummary => Boolean(project));
    if (leaders.length === 0 && projects.length === 0) return null;
    return { ...department, leaders, projects };
  };
  const projects = accountability.projects
    .map((project) => {
      const leadership = filterMembers(project.leadership, tab, showTerminated);
      const continuityOwners = filterOwners(project.continuityOwners);
      const sharedServices = filterMembers(project.sharedServices, tab, showTerminated);
      if (leadership.length === 0 && continuityOwners.length === 0 && sharedServices.length === 0) return null;
      return { ...project, leadership, continuityOwners, sharedServices };
    })
    .filter((project): project is AccountabilityProjectNode => Boolean(project));
  return {
    ...accountability,
    executiveOffice: filterMembers(accountability.executiveOffice, tab, showTerminated),
    projects,
    sharedServices: accountability.sharedServices
      .map((department) => filterOperatingDepartment(department))
      .filter((department): department is OperatingHierarchyDepartmentSummary => Boolean(department)),
    unassigned: filterMembers(accountability.unassigned, tab, showTerminated),
  };
}

function accountabilityCount(accountability: CompanyAgentAccountability) {
  const ids = new Set<string>();
  for (const agent of accountability.executiveOffice) ids.add(agent.id);
  for (const project of accountability.projects) {
    for (const leader of project.leadership) ids.add(leader.id);
    for (const owner of project.continuityOwners) ids.add(owner.id);
    for (const agent of project.sharedServices) ids.add(agent.id);
  }
  for (const department of accountability.sharedServices) {
    for (const agent of department.leaders) ids.add(agent.id);
  }
  for (const agent of accountability.unassigned) ids.add(agent.id);
  return ids.size;
}

function AccountabilityProjectBlock({
  project,
  agentMap,
  liveRunByAgent,
}: {
  project: AccountabilityProjectNode;
  agentMap: Map<string, Agent>;
  liveRunByAgent: Map<string, { runId: string; liveCount: number }>;
}) {
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
        <span>{project.projectName}</span>
        {project.issueCounts.blockedMissingDocs > 0 ? <span>{project.issueCounts.blockedMissingDocs} missing docs</span> : null}
        {project.issueCounts.openReviewFindings > 0 ? <span>{project.issueCounts.openReviewFindings} findings</span> : null}
        {project.issueCounts.returnedBranches > 0 ? <span>{project.issueCounts.returnedBranches} returns</span> : null}
      </div>
      <MemberBlock label="Leadership" members={project.leadership} agentMap={agentMap} liveRunByAgent={liveRunByAgent} />
      <MemberBlock
        label="Continuity Owners"
        members={project.continuityOwners}
        agentMap={agentMap}
        liveRunByAgent={liveRunByAgent}
      />
      <MemberBlock label="Shared Services" members={project.sharedServices} agentMap={agentMap} liveRunByAgent={liveRunByAgent} />
    </section>
  );
}

function AccountabilitySummaryCard({
  accountability,
}: {
  accountability: CompanyAgentAccountability;
}) {
  const counts = accountability.counts;
  return (
    <section className="rounded-xl border border-border/70 bg-card/60 p-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            Lean default
          </div>
          <div className="text-lg font-semibold">
            {counts.activeContinuityOwners} active lanes, {counts.totalConfiguredAgents} configured total
          </div>
        </div>
        <div className="text-xs text-muted-foreground">
          Single-project/internal target: seed 4 live roles, expand to 6 only when new lanes become real.
        </div>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <div>
          <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Continuity</div>
          <div className="mt-1 text-2xl font-semibold">{counts.activeContinuityOwners}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Governance</div>
          <div className="mt-1 text-2xl font-semibold">{counts.activeGovernanceLeads}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Shared Service</div>
          <div className="mt-1 text-2xl font-semibold">{counts.activeSharedServiceAgents}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Legacy / Inactive</div>
          <div className="mt-1 text-2xl font-semibold">{counts.legacyAgents + counts.inactiveAgents}</div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            {counts.legacyAgents} legacy, {counts.inactiveAgents} inactive
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Candidates</div>
          <div className="mt-1 text-2xl font-semibold">{counts.simplificationCandidates}</div>
        </div>
      </div>
    </section>
  );
}

function candidateActionLabel(candidate: OrgSimplificationCandidate) {
  if (candidate.classification === "archive") return "Archive";
  if (candidate.classification === "convert") return "Convert to shared service";
  if (candidate.classification === "merge") return candidate.suggestedTargetName
    ? `Reparent reports to ${candidate.suggestedTargetName}`
    : "Reparent reports";
  return null;
}

function OrgSimplificationPanel({
  report,
  onArchive,
  onConvert,
  onReparentReports,
  pendingAction,
}: {
  report: CompanyOrgSimplificationReport;
  onArchive: (candidate: OrgSimplificationCandidate) => void;
  onConvert: (candidate: OrgSimplificationCandidate) => void;
  onReparentReports: (candidate: OrgSimplificationCandidate) => void;
  pendingAction: string | null;
}) {
  const candidates = report.candidates.filter((candidate) => candidate.classification !== "keep").slice(0, 8);
  if (candidates.length === 0) return null;

  return (
    <section className="rounded-xl border border-border/70 bg-card/60 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            Org simplification
          </div>
          <div className="text-lg font-semibold">
            {report.counts.simplificationCandidates} candidates to simplify
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Archive unused relay roles, collapse singleton layers, and shift permanent specialists toward shared-service usage.
          </p>
        </div>
      </div>
      <div className="mt-4 space-y-3">
        {candidates.map((candidate) => {
          const actionLabel = candidateActionLabel(candidate);
          const actionKey = `${candidate.classification}:${candidate.agent.id}`;
          return (
            <div key={candidate.agent.id} className="rounded-lg border border-border/70 bg-background/50 p-3">
              <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{candidate.agent.name}</span>
                    <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                      {candidate.classification}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {candidate.agent.title ?? candidate.agent.role}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
                    <span>{candidate.activeIssueCount} active issues</span>
                    <span>{candidate.directReportCount} reports</span>
                    <span>{candidate.recentRunCount} recent runs</span>
                    <span>{candidate.activeSharedServiceEngagementCount} engagements</span>
                    <span>{candidate.activeGateCount} gates</span>
                  </div>
                  <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                    {candidate.reasons.slice(0, 3).map((reason) => (
                      <li key={reason}>• {reason}</li>
                    ))}
                  </ul>
                </div>
                {actionLabel ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pendingAction === actionKey}
                    onClick={() => {
                      if (candidate.classification === "archive") onArchive(candidate);
                      if (candidate.classification === "convert") onConvert(candidate);
                      if (candidate.classification === "merge") onReparentReports(candidate);
                    }}
                  >
                    {pendingAction === actionKey ? "Working..." : actionLabel}
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function LayoutToggle({
  layout,
  onChange,
}: {
  layout: AgentLayoutMode;
  onChange: (layout: AgentLayoutMode) => void;
}) {
  return (
    <div className="flex items-center border border-border">
      {(["accountability", "department", "project"] as const).map((value) => (
        <button
          key={value}
          className={cn(
            "px-2.5 py-1.5 text-xs capitalize transition-colors",
            layout === value
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent/50",
          )}
          onClick={() => onChange(value)}
        >
          {value === "accountability" ? "accountability" : value}
        </button>
      ))}
    </div>
  );
}

export function Agents() {
  const { selectedCompanyId } = useCompany();
  const { openNewAgent } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
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

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const [layout, setLayout] = useState<AgentLayoutMode>("accountability");

  useEffect(() => {
    if (!selectedCompanyId) return;
    setLayout(getStoredAgentLayout(selectedCompanyId, currentUserId));
  }, [selectedCompanyId, currentUserId]);

  const { data: agents, isLoading, error } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: navigation } = useQuery({
    queryKey: queryKeys.agents.navigation(selectedCompanyId!, layout === "accountability" ? "department" : layout),
    queryFn: () => agentsApi.navigation(selectedCompanyId!, layout === "accountability" ? "department" : layout),
    enabled: !!selectedCompanyId && effectiveView === "tree" && layout !== "accountability",
  });

  const { data: accountability } = useQuery({
    queryKey: queryKeys.agents.accountability(selectedCompanyId!),
    queryFn: () => agentsApi.accountability(selectedCompanyId!),
    enabled: !!selectedCompanyId && effectiveView === "tree" && layout === "accountability",
  });

  const { data: simplificationReport } = useQuery({
    queryKey: queryKeys.agents.orgSimplification(selectedCompanyId!),
    queryFn: () => agentsApi.orgSimplification(selectedCompanyId!),
    enabled: !!selectedCompanyId,
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

  const refreshAgentViews = () => {
    if (!selectedCompanyId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.accountability(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.navigation(selectedCompanyId, "department") });
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.navigation(selectedCompanyId, "project") });
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.orgSimplification(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(selectedCompanyId) });
  };

  const archiveCandidate = useMutation({
    mutationFn: (candidate: OrgSimplificationCandidate) =>
      agentsApi.archiveForSimplification(selectedCompanyId!, { agentIds: [candidate.agent.id] }),
    onSuccess: refreshAgentViews,
  });

  const convertCandidate = useMutation({
    mutationFn: (candidate: OrgSimplificationCandidate) =>
      agentsApi.convertToSharedServiceForSimplification(selectedCompanyId!, { agentIds: [candidate.agent.id] }),
    onSuccess: refreshAgentViews,
  });

  const reparentReports = useMutation({
    mutationFn: (candidate: OrgSimplificationCandidate) =>
      agentsApi.reparentReportsForSimplification(selectedCompanyId!, {
        fromAgentIds: [candidate.agent.id],
        targetAgentId: candidate.suggestedTargetAgentId!,
      }),
    onSuccess: refreshAgentViews,
  });

  const pendingSimplificationAction =
    (archiveCandidate.isPending && archiveCandidate.variables)
      ? `archive:${archiveCandidate.variables.agent.id}`
      : (convertCandidate.isPending && convertCandidate.variables)
        ? `convert:${convertCandidate.variables.agent.id}`
        : (reparentReports.isPending && reparentReports.variables)
          ? `merge:${reparentReports.variables.agent.id}`
          : null;
  const simplificationError = archiveCandidate.error ?? convertCandidate.error ?? reparentReports.error ?? null;
  const simplificationErrorMessage = simplificationError instanceof Error
    ? simplificationError.message
    : simplificationError
      ? String(simplificationError)
      : null;

  if (!selectedCompanyId) {
    return <EmptyState icon={Bot} message="Select a company to view agents." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const filteredAgents = filterAgents(agents ?? [], tab, showTerminated);
  const filteredNavigation = navigation ? filterNavigation(navigation, tab, showTerminated) : null;
  const filteredAccountability = accountability ? filterAccountability(accountability, tab, showTerminated) : null;
  const filteredNavigationCount = filteredNavigation ? navigationCount(filteredNavigation) : 0;
  const filteredAccountabilityCount = filteredAccountability ? accountabilityCount(filteredAccountability) : 0;
  const archivedCandidateIds = useMemo(
    () => new Set(simplificationReport?.candidates
      .filter((candidate) => candidate.classification === "archive")
      .map((candidate) => candidate.agent.id) ?? []),
    [simplificationReport],
  );

  function updateLayout(next: AgentLayoutMode) {
    if (!selectedCompanyId) return;
    setLayout(next);
    setStoredAgentLayout(selectedCompanyId, next, currentUserId);
  }

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
            <>
              <LayoutToggle layout={layout} onChange={updateLayout} />
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
            </>
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
      {effectiveView === "tree" && (layout === "accountability" ? filteredAccountability : filteredNavigation) ? (
        <p className="text-xs text-muted-foreground">
          {layout === "accountability" && accountability
            ? `${accountability.counts.activeContinuityOwners} active lanes, ${accountability.counts.simplificationCandidates} simplification candidates, ${accountability.counts.totalConfiguredAgents} configured total`
            : `${filteredNavigationCount} agent${filteredNavigationCount !== 1 ? "s" : ""} in ${layout} layout`}
        </p>
      ) : null}

      {error ? <p className="text-sm text-destructive">{error.message}</p> : null}
      {simplificationErrorMessage ? <p className="text-sm text-destructive">{simplificationErrorMessage}</p> : null}

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

      {effectiveView === "tree" && layout === "accountability" && filteredAccountability && filteredAccountabilityCount > 0 ? (
        <div className="space-y-6">
          <AccountabilitySummaryCard accountability={accountability ?? filteredAccountability} />
          {simplificationReport ? (
            <OrgSimplificationPanel
              report={simplificationReport}
              pendingAction={pendingSimplificationAction}
              onArchive={(candidate) => {
                if (!window.confirm(`Archive ${candidate.agent.name}? This will terminate the agent but keep audit history.`)) return;
                archiveCandidate.mutate(candidate);
              }}
              onConvert={(candidate) => {
                if (!window.confirm(`Convert ${candidate.agent.name} to shared-service lead?`)) return;
                convertCandidate.mutate(candidate);
              }}
              onReparentReports={(candidate) => {
                if (!candidate.suggestedTargetAgentId || !candidate.suggestedTargetName) return;
                if (!window.confirm(`Reparent reports from ${candidate.agent.name} to ${candidate.suggestedTargetName}?`)) return;
                reparentReports.mutate(candidate);
              }}
            />
          ) : null}
          {filteredAccountability.executiveOffice.length > 0 ? (
            <section className="space-y-3">
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                Executive Office
              </div>
              <MemberBlock
                label="Governance"
                members={filteredAccountability.executiveOffice}
                agentMap={agentMap}
                liveRunByAgent={liveRunByAgent}
              />
            </section>
          ) : null}

          {filteredAccountability.projects.map((project) => (
            <AccountabilityProjectBlock
              key={project.projectId ?? project.projectName}
              project={project}
              agentMap={agentMap}
              liveRunByAgent={liveRunByAgent}
            />
          ))}

          {filteredAccountability.sharedServices.length > 0 ? (
            <section className="space-y-4">
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                Shared Services
              </div>
              {filteredAccountability.sharedServices.map((department) => (
                <OperatingDepartmentBlock
                  key={`${department.key}:${department.name}`}
                  department={department}
                  agentMap={agentMap}
                  liveRunByAgent={liveRunByAgent}
                />
              ))}
            </section>
          ) : null}

          {filteredAccountability.unassigned.length > 0 ? (
            <section className="space-y-3">
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                Unassigned
              </div>
              <MemberBlock
                label="Needs scope"
                members={filteredAccountability.unassigned.filter((member) => !archivedCandidateIds.has(member.id))}
                agentMap={agentMap}
                liveRunByAgent={liveRunByAgent}
              />
              {filteredAccountability.unassigned.some((member) => archivedCandidateIds.has(member.id)) ? (
                <details className="rounded-xl border border-border/70 bg-card/40 p-4">
                  <summary className="cursor-pointer text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                    Legacy / inactive ({filteredAccountability.unassigned.filter((member) => archivedCandidateIds.has(member.id)).length})
                  </summary>
                  <div className="mt-3">
                    <MemberBlock
                      label="Compatibility only"
                      members={filteredAccountability.unassigned.filter((member) => archivedCandidateIds.has(member.id))}
                      agentMap={agentMap}
                      liveRunByAgent={liveRunByAgent}
                    />
                  </div>
                </details>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}

      {effectiveView === "tree" && layout !== "accountability" && filteredNavigation && filteredNavigationCount > 0 ? (
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

          {layout === "department"
            ? filteredNavigation.departments.map((department) => (
                <DepartmentBlock
                  key={`${department.key}:${department.name}`}
                  department={department}
                  agentMap={agentMap}
                  liveRunByAgent={liveRunByAgent}
                />
              ))
            : (filteredNavigation.portfolioClusters?.length ?? 0) > 0
              ? (filteredNavigation.portfolioClusters ?? []).map((cluster) => (
                  <ClusterBlock
                    key={cluster.clusterId}
                    cluster={cluster}
                    agentMap={agentMap}
                    liveRunByAgent={liveRunByAgent}
                  />
                ))
              : filteredNavigation.projectPods.map((project) => (
                  <ProjectBlock
                    key={project.projectId}
                    project={project}
                    agentMap={agentMap}
                    liveRunByAgent={liveRunByAgent}
                  />
                ))}

          {filteredNavigation.sharedServices.length > 0 ? (
            <section className="space-y-4">
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                Shared Services
              </div>
              {filteredNavigation.sharedServices.map((department) => (
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
                Unassigned
              </div>
              <MemberBlock
                label="Needs staffing scope"
                members={filteredNavigation.unassigned}
                agentMap={agentMap}
                liveRunByAgent={liveRunByAgent}
              />
            </section>
          ) : null}
        </div>
      ) : null}

      {effectiveView === "tree" && layout === "accountability" && filteredAccountability && filteredAccountabilityCount === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No agents match the selected filter.
        </p>
      ) : null}

      {effectiveView === "tree" && layout !== "accountability" && filteredNavigation && filteredNavigationCount === 0 ? (
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

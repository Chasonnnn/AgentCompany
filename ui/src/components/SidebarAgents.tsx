import { type ReactNode, useEffect, useMemo, useState } from "react";
import { NavLink, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, FolderTree, Plus } from "lucide-react";
import type {
  Agent,
  AccountabilityAgentSummary,
  AccountabilityProjectNode,
  AgentHierarchyMemberSummary,
  AgentNavigationClusterNode,
  AgentNavigationDepartmentNode,
  AgentNavigationLayout,
  AgentNavigationProjectNode,
  AgentNavigationTeamNode,
  CompanyAgentAccountability,
  CompanyAgentNavigation,
  OperatingHierarchyDepartmentSummary,
  OperatingHierarchyProjectSummary,
} from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { getStoredAgentLayout, setStoredAgentLayout, type AgentLayoutMode } from "../lib/agent-layout";
import { SIDEBAR_SCROLL_RESET_STATE } from "../lib/navigation-scroll";
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
  count,
  defaultOpen = false,
  autoOpen = false,
  open,
  onOpenChange,
  depth = 0,
  children,
}: {
  label: string;
  count?: number;
  defaultOpen?: boolean;
  autoOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  depth?: number;
  children: ReactNode;
}) {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const effectiveOpen = open ?? (autoOpen || (manualOpen ?? defaultOpen));
  const railLeft = 12 + depth * 16 + 11;

  return (
    <Collapsible open={effectiveOpen} onOpenChange={onOpenChange ?? setManualOpen}>
      <CollapsibleTrigger
        className="flex w-full items-center gap-1 px-3 py-1 text-left text-[11px] uppercase tracking-[0.16em] text-muted-foreground/80 hover:text-foreground"
        style={{ paddingLeft: 12 + depth * 16 }}
      >
        <ChevronRight
          className={cn("h-3 w-3 shrink-0 transition-transform", effectiveOpen && "rotate-90")}
        />
        <FolderTree className="h-3 w-3 shrink-0" />
        <span className="truncate">{label}</span>
        {typeof count === "number" ? (
          <span className="ml-auto shrink-0 text-[10px] font-medium tracking-normal text-muted-foreground/70">
            {count}
          </span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="relative">
          {depth > 0 ? (
            <div
              aria-hidden
              className="pointer-events-none absolute bottom-1 top-0 w-px bg-border/45"
              style={{ left: railLeft }}
            />
          ) : null}
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function SidebarAgentLink({
  summary,
  agent,
  activeAgentId,
  activeTab,
  runCount,
  depth = 0,
}: {
  summary: AgentHierarchyMemberSummary;
  agent: Agent | null;
  activeAgentId: string | null;
  activeTab: string | null;
  runCount: number;
  depth?: number;
}) {
  const { isMobile, setSidebarOpen } = useSidebar();
  const target = agent ?? summary;
  return (
    <NavLink
      to={activeTab ? `${agentUrl(target)}/${activeTab}` : agentUrl(target)}
      state={SIDEBAR_SCROLL_RESET_STATE}
      onClick={() => {
        if (isMobile) setSidebarOpen(false);
      }}
      className={cn(
        "flex items-center gap-2.5 py-1.5 pr-3 text-[13px] font-medium transition-colors",
        activeAgentId === agentRouteRef(target)
          ? "bg-accent text-foreground"
          : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
      )}
      style={{ paddingLeft: 12 + depth * 16 }}
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
  depth = 0,
}: {
  members: AgentHierarchyMemberSummary[];
  agentMap: Map<string, Agent>;
  liveCountByAgent: Map<string, number>;
  activeAgentId: string | null;
  activeTab: string | null;
  depth?: number;
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
          depth={depth}
        />
      ))}
    </div>
  );
}

function isActiveMember(summary: AgentHierarchyMemberSummary, activeAgentId: string | null) {
  if (!activeAgentId) return false;
  return summary.id === activeAgentId || agentRouteRef(summary) === activeAgentId;
}

function hasActiveMember(
  members: AgentHierarchyMemberSummary[],
  activeAgentId: string | null,
) {
  return members.some((member) => isActiveMember(member, activeAgentId));
}

function countMembers(members: AgentHierarchyMemberSummary[]) {
  return members.length;
}

function operatingProjectHasActiveMember(
  project: OperatingHierarchyProjectSummary,
  activeAgentId: string | null,
) {
  return hasActiveMember(project.leadership, activeAgentId)
    || hasActiveMember(project.workers, activeAgentId)
    || hasActiveMember(project.consultants, activeAgentId);
}

function countOperatingProject(project: OperatingHierarchyProjectSummary) {
  return countMembers(project.leadership)
    + countMembers(project.workers)
    + countMembers(project.consultants);
}

function operatingDepartmentHasActiveMember(
  department: OperatingHierarchyDepartmentSummary,
  activeAgentId: string | null,
) {
  return hasActiveMember(department.leaders, activeAgentId)
    || department.projects.some((project) => operatingProjectHasActiveMember(project, activeAgentId));
}

function countOperatingDepartment(department: OperatingHierarchyDepartmentSummary) {
  return countMembers(department.leaders)
    + department.projects.reduce((sum, project) => sum + countOperatingProject(project), 0);
}

function teamHasActiveMember(team: AgentNavigationTeamNode, activeAgentId: string | null) {
  return hasActiveMember(team.leaders, activeAgentId) || hasActiveMember(team.workers, activeAgentId);
}

function countTeam(team: AgentNavigationTeamNode) {
  return countMembers(team.leaders) + countMembers(team.workers);
}

function projectHasActiveMember(project: AgentNavigationProjectNode, activeAgentId: string | null) {
  return hasActiveMember(project.leaders, activeAgentId)
    || project.teams.some((team) => teamHasActiveMember(team, activeAgentId))
    || hasActiveMember(project.workers, activeAgentId);
}

function countProject(project: AgentNavigationProjectNode) {
  return countMembers(project.leaders)
    + project.teams.reduce((sum, team) => sum + countTeam(team), 0)
    + countMembers(project.workers);
}

function clusterHasActiveMember(cluster: AgentNavigationClusterNode, activeAgentId: string | null) {
  return (cluster.portfolioDirector ? isActiveMember(cluster.portfolioDirector, activeAgentId) : false)
    || cluster.projects.some((project) => projectHasActiveMember(project, activeAgentId));
}

function countCluster(cluster: AgentNavigationClusterNode) {
  return (cluster.portfolioDirector ? 1 : 0)
    + cluster.projects.reduce((sum, project) => sum + countProject(project), 0);
}

function departmentHasActiveMember(
  department: AgentNavigationDepartmentNode,
  activeAgentId: string | null,
) {
  return hasActiveMember(department.leaders, activeAgentId)
    || (department.clusters ?? []).some((cluster) => clusterHasActiveMember(cluster, activeAgentId))
    || department.projects.some((project) => projectHasActiveMember(project, activeAgentId));
}

function countDepartment(department: AgentNavigationDepartmentNode) {
  return countMembers(department.leaders)
    + (department.clusters ?? []).reduce((sum, cluster) => sum + countCluster(cluster), 0)
    + department.projects.reduce((sum, project) => sum + countProject(project), 0);
}

function countAccountabilityProject(project: AccountabilityProjectNode) {
  return project.leadership.length + project.continuityOwners.length + project.sharedServices.length;
}

function accountabilityOwnerHasActiveMember(
  owner: AccountabilityAgentSummary,
  activeAgentId: string | null,
) {
  return isActiveMember(owner, activeAgentId);
}

function accountabilityProjectHasActiveMember(
  project: AccountabilityProjectNode,
  activeAgentId: string | null,
) {
  return hasActiveMember(project.leadership, activeAgentId)
    || project.continuityOwners.some((owner) => accountabilityOwnerHasActiveMember(owner, activeAgentId))
    || hasActiveMember(project.sharedServices, activeAgentId);
}

function useSingleOpenBranch(activeKey: string | null) {
  const [manualKey, setManualKey] = useState<string | null>(null);
  return {
    openKey: activeKey ?? manualKey,
    setOpenKey: setManualKey,
  };
}

function accordionFolderControl(
  key: string,
  openKey: string | null,
  setOpenKey: (key: string | null) => void,
) {
  return {
    open: openKey === key,
    onOpenChange: (next: boolean) => setOpenKey(next ? key : null),
  };
}

function MemberSection({
  label,
  members,
  agentMap,
  liveCountByAgent,
  activeAgentId,
  activeTab,
  parentDepth,
  defaultOpen = false,
  open,
  onOpenChange,
}: {
  label: string;
  members: AgentHierarchyMemberSummary[];
  agentMap: Map<string, Agent>;
  liveCountByAgent: Map<string, number>;
  activeAgentId: string | null;
  activeTab: string | null;
  parentDepth: number;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  if (members.length === 0) return null;

  if (members.length === 1) {
    return (
      <MemberList
        members={members}
        agentMap={agentMap}
        liveCountByAgent={liveCountByAgent}
        activeAgentId={activeAgentId}
        activeTab={activeTab}
        depth={parentDepth + 1}
      />
    );
  }

  return (
    <HierarchyFolder
      label={label}
      count={members.length}
      depth={parentDepth + 1}
      defaultOpen={defaultOpen}
      autoOpen={hasActiveMember(members, activeAgentId)}
      open={open}
      onOpenChange={onOpenChange}
    >
      <MemberList
        members={members}
        agentMap={agentMap}
        liveCountByAgent={liveCountByAgent}
        activeAgentId={activeAgentId}
        activeTab={activeTab}
        depth={parentDepth + 2}
      />
    </HierarchyFolder>
  );
}

function TeamSection({
  team,
  agentMap,
  liveCountByAgent,
  activeAgentId,
  activeTab,
  depth,
  open,
  onOpenChange,
}: {
  team: AgentNavigationTeamNode;
  agentMap: Map<string, Agent>;
  liveCountByAgent: Map<string, number>;
  activeAgentId: string | null;
  activeTab: string | null;
  depth: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const activeBranchKey = hasActiveMember(team.leaders, activeAgentId)
    ? "leads"
    : hasActiveMember(team.workers, activeAgentId)
      ? "workers"
      : null;
  const { openKey, setOpenKey } = useSingleOpenBranch(activeBranchKey);
  if (team.leaders.length === 0 && team.workers.length === 0) return null;
  return (
    <HierarchyFolder
      label={team.label}
      count={countTeam(team)}
      depth={depth}
      defaultOpen={false}
      autoOpen={teamHasActiveMember(team, activeAgentId)}
      open={open}
      onOpenChange={onOpenChange}
    >
      <MemberSection
        label="Leads"
        members={team.leaders}
        agentMap={agentMap}
        liveCountByAgent={liveCountByAgent}
        activeAgentId={activeAgentId}
        activeTab={activeTab}
        parentDepth={depth}
        {...accordionFolderControl("leads", openKey, setOpenKey)}
      />
      <MemberSection
        label="Workers"
        members={team.workers}
        agentMap={agentMap}
        liveCountByAgent={liveCountByAgent}
        activeAgentId={activeAgentId}
        activeTab={activeTab}
        parentDepth={depth}
        defaultOpen={false}
        {...accordionFolderControl("workers", openKey, setOpenKey)}
      />
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
  open,
  onOpenChange,
}: {
  project: AgentNavigationProjectNode;
  agentMap: Map<string, Agent>;
  liveCountByAgent: Map<string, number>;
  activeAgentId: string | null;
  activeTab: string | null;
  depth: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const activeTeam = project.teams.find((team) => teamHasActiveMember(team, activeAgentId));
  const activeBranchKey = hasActiveMember(project.leaders, activeAgentId)
    ? "leadership"
    : activeTeam
      ? `team:${activeTeam.key}`
      : hasActiveMember(project.workers, activeAgentId)
        ? "workers"
        : null;
  const { openKey, setOpenKey } = useSingleOpenBranch(activeBranchKey);
  if (project.leaders.length === 0 && project.teams.length === 0 && project.workers.length === 0) {
    return null;
  }

  return (
    <HierarchyFolder
      label={project.projectName}
      count={countProject(project)}
      depth={depth}
      autoOpen={projectHasActiveMember(project, activeAgentId)}
      open={open}
      onOpenChange={onOpenChange}
    >
      <MemberSection
        label="Leadership"
        members={project.leaders}
        agentMap={agentMap}
        liveCountByAgent={liveCountByAgent}
        activeAgentId={activeAgentId}
        activeTab={activeTab}
        parentDepth={depth}
        {...accordionFolderControl("leadership", openKey, setOpenKey)}
      />
      {project.teams.map((team) => (
        <TeamSection
          key={`${project.projectId}:${team.key}`}
          team={team}
          agentMap={agentMap}
          liveCountByAgent={liveCountByAgent}
          activeAgentId={activeAgentId}
          activeTab={activeTab}
          depth={depth + 1}
          {...accordionFolderControl(`team:${team.key}`, openKey, setOpenKey)}
        />
      ))}
      <MemberSection
        label="Workers"
        members={project.workers}
        agentMap={agentMap}
        liveCountByAgent={liveCountByAgent}
        activeAgentId={activeAgentId}
        activeTab={activeTab}
        parentDepth={depth}
        defaultOpen={false}
        {...accordionFolderControl("workers", openKey, setOpenKey)}
      />
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
  open,
  onOpenChange,
}: {
  cluster: AgentNavigationClusterNode;
  agentMap: Map<string, Agent>;
  liveCountByAgent: Map<string, number>;
  activeAgentId: string | null;
  activeTab: string | null;
  depth: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const activeProject = cluster.projects.find((project) => projectHasActiveMember(project, activeAgentId));
  const activeBranchKey = cluster.portfolioDirector && isActiveMember(cluster.portfolioDirector, activeAgentId)
    ? "portfolio-director"
    : activeProject
      ? `project:${activeProject.projectId}`
      : null;
  const { openKey, setOpenKey } = useSingleOpenBranch(activeBranchKey);
  if ((cluster.portfolioDirector == null) && cluster.projects.length === 0) {
    return null;
  }

  return (
    <HierarchyFolder
      label={cluster.name}
      count={countCluster(cluster)}
      depth={depth}
      autoOpen={clusterHasActiveMember(cluster, activeAgentId)}
      open={open}
      onOpenChange={onOpenChange}
    >
      {cluster.portfolioDirector ? (
        <MemberSection
          label="Portfolio Director"
          members={[cluster.portfolioDirector]}
          agentMap={agentMap}
          liveCountByAgent={liveCountByAgent}
          activeAgentId={activeAgentId}
          activeTab={activeTab}
          parentDepth={depth}
          {...accordionFolderControl("portfolio-director", openKey, setOpenKey)}
        />
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
          {...accordionFolderControl(`project:${project.projectId}`, openKey, setOpenKey)}
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
  open,
  onOpenChange,
}: {
  department: AgentNavigationDepartmentNode;
  agentMap: Map<string, Agent>;
  liveCountByAgent: Map<string, number>;
  activeAgentId: string | null;
  activeTab: string | null;
  depth: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const clusters = department.clusters ?? [];
  const hasClusterTree = clusters.length > 0;
  const activeCluster = clusters.find((cluster) => clusterHasActiveMember(cluster, activeAgentId));
  const activeProject = !activeCluster
    ? department.projects.find((project) => projectHasActiveMember(project, activeAgentId))
    : null;
  const activeBranchKey = hasActiveMember(department.leaders, activeAgentId)
    ? "leads"
    : activeCluster
      ? `cluster:${activeCluster.clusterId}`
      : activeProject
        ? `project:${activeProject.projectId}`
        : null;
  const { openKey, setOpenKey } = useSingleOpenBranch(activeBranchKey);
  if (department.leaders.length === 0 && clusters.length === 0 && department.projects.length === 0) return null;

  return (
    <HierarchyFolder
      label={department.name}
      count={countDepartment(department)}
      depth={depth}
      autoOpen={departmentHasActiveMember(department, activeAgentId)}
      open={open}
      onOpenChange={onOpenChange}
    >
      <MemberSection
        label="Leads"
        members={department.leaders}
        agentMap={agentMap}
        liveCountByAgent={liveCountByAgent}
        activeAgentId={activeAgentId}
        activeTab={activeTab}
        parentDepth={depth}
        {...accordionFolderControl("leads", openKey, setOpenKey)}
      />
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
              {...accordionFolderControl(`cluster:${cluster.clusterId}`, openKey, setOpenKey)}
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
              {...accordionFolderControl(`project:${project.projectId}`, openKey, setOpenKey)}
            />
          ))}
    </HierarchyFolder>
  );
}

function OperatingProjectSection({
  project,
  agentMap,
  liveCountByAgent,
  activeAgentId,
  activeTab,
  depth,
  open,
  onOpenChange,
}: {
  project: OperatingHierarchyProjectSummary;
  agentMap: Map<string, Agent>;
  liveCountByAgent: Map<string, number>;
  activeAgentId: string | null;
  activeTab: string | null;
  depth: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  if (project.leadership.length === 0 && project.workers.length === 0 && project.consultants.length === 0) {
    return null;
  }
  const activeBranchKey = hasActiveMember(project.leadership, activeAgentId)
    ? "leadership"
    : hasActiveMember(project.workers, activeAgentId)
      ? "workers"
      : hasActiveMember(project.consultants, activeAgentId)
        ? "consultants"
        : null;
  const { openKey, setOpenKey } = useSingleOpenBranch(activeBranchKey);

  return (
    <HierarchyFolder
      label={project.projectName}
      count={countOperatingProject(project)}
      depth={depth}
      autoOpen={operatingProjectHasActiveMember(project, activeAgentId)}
      open={open}
      onOpenChange={onOpenChange}
    >
      <MemberSection
        label="Leadership"
        members={project.leadership}
        agentMap={agentMap}
        liveCountByAgent={liveCountByAgent}
        activeAgentId={activeAgentId}
        activeTab={activeTab}
        parentDepth={depth}
        {...accordionFolderControl("leadership", openKey, setOpenKey)}
      />
      <MemberSection
        label="Workers"
        members={project.workers}
        agentMap={agentMap}
        liveCountByAgent={liveCountByAgent}
        activeAgentId={activeAgentId}
        activeTab={activeTab}
        parentDepth={depth}
        {...accordionFolderControl("workers", openKey, setOpenKey)}
      />
      <MemberSection
        label="Consultants"
        members={project.consultants}
        agentMap={agentMap}
        liveCountByAgent={liveCountByAgent}
        activeAgentId={activeAgentId}
        activeTab={activeTab}
        parentDepth={depth}
        {...accordionFolderControl("consultants", openKey, setOpenKey)}
      />
    </HierarchyFolder>
  );
}

function OperatingDepartmentSection({
  department,
  agentMap,
  liveCountByAgent,
  activeAgentId,
  activeTab,
  depth,
  open,
  onOpenChange,
}: {
  department: OperatingHierarchyDepartmentSummary;
  agentMap: Map<string, Agent>;
  liveCountByAgent: Map<string, number>;
  activeAgentId: string | null;
  activeTab: string | null;
  depth: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  if (department.leaders.length === 0 && department.projects.length === 0) return null;
  const activeProject = department.projects.find((project) => operatingProjectHasActiveMember(project, activeAgentId));
  const activeBranchKey = hasActiveMember(department.leaders, activeAgentId)
    ? "leads"
    : activeProject
      ? `project:${activeProject.projectId}`
      : null;
  const { openKey, setOpenKey } = useSingleOpenBranch(activeBranchKey);

  return (
    <HierarchyFolder
      label={department.name}
      count={countOperatingDepartment(department)}
      depth={depth}
      autoOpen={operatingDepartmentHasActiveMember(department, activeAgentId)}
      open={open}
      onOpenChange={onOpenChange}
    >
      <MemberSection
        label="Leads"
        members={department.leaders}
        agentMap={agentMap}
        liveCountByAgent={liveCountByAgent}
        activeAgentId={activeAgentId}
        activeTab={activeTab}
        parentDepth={depth}
        {...accordionFolderControl("leads", openKey, setOpenKey)}
      />
      {department.projects.map((project) => (
        <OperatingProjectSection
          key={`${department.key}:${project.projectId}`}
          project={project}
          agentMap={agentMap}
          liveCountByAgent={liveCountByAgent}
          activeAgentId={activeAgentId}
          activeTab={activeTab}
          depth={depth + 1}
          {...accordionFolderControl(`project:${project.projectId}`, openKey, setOpenKey)}
        />
      ))}
    </HierarchyFolder>
  );
}

function AccountabilityOwnerRow({
  owner,
  agentMap,
  liveCountByAgent,
  activeAgentId,
  activeTab,
  depth = 0,
}: {
  owner: AccountabilityAgentSummary;
  agentMap: Map<string, Agent>;
  liveCountByAgent: Map<string, number>;
  activeAgentId: string | null;
  activeTab: string | null;
  depth?: number;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <SidebarAgentLink
        summary={owner}
        agent={agentMap.get(owner.id) ?? null}
        activeAgentId={activeAgentId}
        activeTab={activeTab}
        runCount={liveCountByAgent.get(owner.id) ?? 0}
        depth={depth}
      />
      <div
        className="flex flex-wrap gap-1 text-[10px] text-muted-foreground"
        style={{ paddingLeft: 28 + depth * 16 }}
      >
        <span>{owner.activeIssueCount} issue{owner.activeIssueCount === 1 ? "" : "s"}</span>
        {owner.blockedContinuityIssueCount > 0 ? <span>{owner.blockedContinuityIssueCount} blocked</span> : null}
        {owner.openReviewFindingsCount > 0 ? <span>{owner.openReviewFindingsCount} findings</span> : null}
        {owner.returnedBranchCount > 0 ? <span>{owner.returnedBranchCount} returns</span> : null}
      </div>
    </div>
  );
}

function AccountabilityProjectSection({
  project,
  agentMap,
  liveCountByAgent,
  activeAgentId,
  activeTab,
  depth = 0,
  open,
  onOpenChange,
}: {
  project: AccountabilityProjectNode;
  agentMap: Map<string, Agent>;
  liveCountByAgent: Map<string, number>;
  activeAgentId: string | null;
  activeTab: string | null;
  depth?: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const activeKey = hasActiveMember(project.leadership, activeAgentId)
    ? "leadership"
    : project.continuityOwners.some((owner) => accountabilityOwnerHasActiveMember(owner, activeAgentId))
      ? "owners"
      : hasActiveMember(project.sharedServices, activeAgentId)
        ? "shared"
        : null;
  const { openKey, setOpenKey } = useSingleOpenBranch(activeKey);
  const issueSignals = [
    project.issueCounts.blockedMissingDocs > 0 ? `${project.issueCounts.blockedMissingDocs} missing docs` : null,
    project.issueCounts.openReviewFindings > 0 ? `${project.issueCounts.openReviewFindings} findings` : null,
    project.issueCounts.returnedBranches > 0 ? `${project.issueCounts.returnedBranches} returns` : null,
    project.issueCounts.handoffPending > 0 ? `${project.issueCounts.handoffPending} handoffs` : null,
  ].filter(Boolean);

  return (
    <HierarchyFolder
      label={project.projectName}
      count={countAccountabilityProject(project)}
      depth={depth}
      autoOpen={accountabilityProjectHasActiveMember(project, activeAgentId)}
      open={open}
      onOpenChange={onOpenChange}
    >
      {issueSignals.length > 0 ? (
        <div
          className="flex flex-wrap gap-1 px-3 py-1 text-[10px] text-muted-foreground"
          style={{ paddingLeft: 28 + depth * 16 }}
        >
          {issueSignals.map((signal) => (
            <span key={signal}>{signal}</span>
          ))}
        </div>
      ) : null}
      <MemberSection
        label="Leadership"
        members={project.leadership}
        agentMap={agentMap}
        liveCountByAgent={liveCountByAgent}
        activeAgentId={activeAgentId}
        activeTab={activeTab}
        parentDepth={depth}
        {...accordionFolderControl("leadership", openKey, setOpenKey)}
      />
      {project.continuityOwners.length > 0 ? (
        <HierarchyFolder
          label="Continuity Owners"
          count={project.continuityOwners.length}
          depth={depth + 1}
          autoOpen={project.continuityOwners.some((owner) => accountabilityOwnerHasActiveMember(owner, activeAgentId))}
          {...accordionFolderControl("owners", openKey, setOpenKey)}
        >
          <div className="flex flex-col gap-1">
            {project.continuityOwners.map((owner) => (
              <AccountabilityOwnerRow
                key={owner.id}
                owner={owner}
                agentMap={agentMap}
                liveCountByAgent={liveCountByAgent}
                activeAgentId={activeAgentId}
                activeTab={activeTab}
                depth={depth + 2}
              />
            ))}
          </div>
        </HierarchyFolder>
      ) : null}
      <MemberSection
        label="Shared Services"
        members={project.sharedServices}
        agentMap={agentMap}
        liveCountByAgent={liveCountByAgent}
        activeAgentId={activeAgentId}
        activeTab={activeTab}
        parentDepth={depth}
        {...accordionFolderControl("shared", openKey, setOpenKey)}
      />
    </HierarchyFolder>
  );
}

function AccountabilityContent({
  accountability,
  agentMap,
  liveCountByAgent,
  activeAgentId,
  activeTab,
}: {
  accountability: CompanyAgentAccountability;
  agentMap: Map<string, Agent>;
  liveCountByAgent: Map<string, number>;
  activeAgentId: string | null;
  activeTab: string | null;
}) {
  const activeProject = accountability.projects.find((project) => accountabilityProjectHasActiveMember(project, activeAgentId));
  const activeTopLevelKey = hasActiveMember(accountability.executiveOffice, activeAgentId)
    ? "executive-office"
    : activeProject
      ? "projects"
      : accountability.sharedServices.some((group) => operatingDepartmentHasActiveMember(group, activeAgentId))
        ? "shared-services"
        : hasActiveMember(accountability.unassigned, activeAgentId)
          ? "unassigned"
          : null;
  const { openKey: topLevelOpenKey, setOpenKey: setTopLevelOpenKey } = useSingleOpenBranch(activeTopLevelKey);
  const { openKey: projectOpenKey, setOpenKey: setProjectOpenKey } = useSingleOpenBranch(activeProject?.projectId ?? null);

  return (
    <div className="mt-0.5 flex flex-col gap-1">
      {accountability.executiveOffice.length > 0 ? (
        <HierarchyFolder
          label="Executive Office"
          count={accountability.executiveOffice.length}
          autoOpen={hasActiveMember(accountability.executiveOffice, activeAgentId)}
          {...accordionFolderControl("executive-office", topLevelOpenKey, setTopLevelOpenKey)}
        >
          <MemberList
            members={accountability.executiveOffice}
            agentMap={agentMap}
            liveCountByAgent={liveCountByAgent}
            activeAgentId={activeAgentId}
            activeTab={activeTab}
            depth={1}
          />
        </HierarchyFolder>
      ) : null}

      {accountability.projects.length > 0 ? (
        <HierarchyFolder
          label="Projects"
          count={accountability.projects.reduce((sum, project) => sum + countAccountabilityProject(project), 0)}
          autoOpen={accountability.projects.some((project) => accountabilityProjectHasActiveMember(project, activeAgentId))}
          {...accordionFolderControl("projects", topLevelOpenKey, setTopLevelOpenKey)}
        >
          {accountability.projects.map((project) => (
            <AccountabilityProjectSection
              key={project.projectId ?? project.projectName}
              project={project}
              agentMap={agentMap}
              liveCountByAgent={liveCountByAgent}
              activeAgentId={activeAgentId}
              activeTab={activeTab}
              depth={1}
              {...accordionFolderControl(project.projectId ?? project.projectName, projectOpenKey, setProjectOpenKey)}
            />
          ))}
        </HierarchyFolder>
      ) : null}

      {accountability.sharedServices.length > 0 ? (
        <HierarchyFolder
          label="Shared Services"
          count={accountability.sharedServices.reduce((sum, department) => sum + countOperatingDepartment(department), 0)}
          autoOpen={accountability.sharedServices.some((department) => operatingDepartmentHasActiveMember(department, activeAgentId))}
          {...accordionFolderControl("shared-services", topLevelOpenKey, setTopLevelOpenKey)}
        >
          {accountability.sharedServices.map((department) => (
            <OperatingDepartmentSection
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

      {accountability.unassigned.length > 0 ? (
        <HierarchyFolder
          label="Unassigned"
          count={accountability.unassigned.length}
          autoOpen={hasActiveMember(accountability.unassigned, activeAgentId)}
          {...accordionFolderControl("unassigned", topLevelOpenKey, setTopLevelOpenKey)}
        >
          <MemberList
            members={accountability.unassigned}
            agentMap={agentMap}
            liveCountByAgent={liveCountByAgent}
            activeAgentId={activeAgentId}
            activeTab={activeTab}
            depth={1}
          />
        </HierarchyFolder>
      ) : null}
    </div>
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
    <div className="mx-3 mb-2 flex rounded-md border border-border/70 bg-background/70 p-0.5">
      {(["accountability", "department", "project"] as const).map((value) => (
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
          {value === "accountability" ? "Accountability" : value}
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
  const activeDepartment = navigation.departments.find((department) =>
    departmentHasActiveMember(department, activeAgentId),
  );
  const activeCluster = (navigation.portfolioClusters ?? []).find((cluster) =>
    clusterHasActiveMember(cluster, activeAgentId),
  );
  const activeProjectPod = navigation.projectPods.find((project) =>
    projectHasActiveMember(project, activeAgentId),
  );
  const activeSharedService = navigation.sharedServices.find((department) =>
    departmentHasActiveMember(department, activeAgentId),
  );
  const activeTopLevelKey = hasActiveMember(navigation.executives, activeAgentId)
    ? "executives"
    : activeDepartment
      ? "departments"
      : activeCluster
        ? "portfolio-clusters"
        : activeProjectPod
          ? "project-pods"
          : activeSharedService
            ? "shared-services"
            : hasActiveMember(navigation.unassigned, activeAgentId)
              ? "unassigned"
              : null;
  const { openKey: topLevelOpenKey, setOpenKey: setTopLevelOpenKey } = useSingleOpenBranch(activeTopLevelKey);

  const activeDepartmentKey = activeDepartment ? `${activeDepartment.key}:${activeDepartment.name}` : null;
  const { openKey: departmentOpenKey, setOpenKey: setDepartmentOpenKey } = useSingleOpenBranch(activeDepartmentKey);

  const activeClusterKey = activeCluster ? activeCluster.clusterId : null;
  const { openKey: clusterOpenKey, setOpenKey: setClusterOpenKey } = useSingleOpenBranch(activeClusterKey);

  const activeProjectPodKey = activeProjectPod ? activeProjectPod.projectId : null;
  const { openKey: projectPodOpenKey, setOpenKey: setProjectPodOpenKey } = useSingleOpenBranch(activeProjectPodKey);

  const activeSharedServiceKey = activeSharedService ? `${activeSharedService.key}:${activeSharedService.name}` : null;
  const { openKey: sharedServiceOpenKey, setOpenKey: setSharedServiceOpenKey } = useSingleOpenBranch(activeSharedServiceKey);

  return (
    <div className="mt-0.5 flex flex-col gap-1">
      {navigation.executives.length > 0 ? (
        <HierarchyFolder
          label="Executives"
          count={navigation.executives.length}
          autoOpen={hasActiveMember(navigation.executives, activeAgentId)}
          {...accordionFolderControl("executives", topLevelOpenKey, setTopLevelOpenKey)}
        >
          <MemberList
            members={navigation.executives}
            agentMap={agentMap}
            liveCountByAgent={liveCountByAgent}
            activeAgentId={activeAgentId}
            activeTab={activeTab}
            depth={1}
          />
        </HierarchyFolder>
      ) : null}

      {navigation.layout === "department" ? (
        navigation.departments.length > 0 ? (
          <HierarchyFolder
            label="Departments"
            count={navigation.departments.reduce((sum, department) => sum + countDepartment(department), 0)}
            autoOpen={navigation.departments.some((department) => departmentHasActiveMember(department, activeAgentId))}
            {...accordionFolderControl("departments", topLevelOpenKey, setTopLevelOpenKey)}
          >
            {navigation.departments.map((department) => (
              <DepartmentSection
                key={`${department.key}:${department.name}`}
                department={department}
                agentMap={agentMap}
                liveCountByAgent={liveCountByAgent}
                activeAgentId={activeAgentId}
                activeTab={activeTab}
                depth={1}
                {...accordionFolderControl(`${department.key}:${department.name}`, departmentOpenKey, setDepartmentOpenKey)}
              />
            ))}
          </HierarchyFolder>
        ) : null
      ) : (navigation.portfolioClusters?.length ?? 0) > 0 ? (
        <HierarchyFolder
          label="Portfolio Clusters"
          count={(navigation.portfolioClusters ?? []).reduce((sum, cluster) => sum + countCluster(cluster), 0)}
          autoOpen={(navigation.portfolioClusters ?? []).some((cluster) => clusterHasActiveMember(cluster, activeAgentId))}
          {...accordionFolderControl("portfolio-clusters", topLevelOpenKey, setTopLevelOpenKey)}
        >
          {(navigation.portfolioClusters ?? []).map((cluster) => (
            <ClusterSection
              key={cluster.clusterId}
              cluster={cluster}
              agentMap={agentMap}
              liveCountByAgent={liveCountByAgent}
              activeAgentId={activeAgentId}
              activeTab={activeTab}
              depth={1}
              {...accordionFolderControl(cluster.clusterId, clusterOpenKey, setClusterOpenKey)}
            />
          ))}
        </HierarchyFolder>
      ) : navigation.projectPods.length > 0 ? (
        <HierarchyFolder
          label="Project Pods"
          count={navigation.projectPods.reduce((sum, project) => sum + countProject(project), 0)}
          autoOpen={navigation.projectPods.some((project) => projectHasActiveMember(project, activeAgentId))}
          {...accordionFolderControl("project-pods", topLevelOpenKey, setTopLevelOpenKey)}
        >
          {navigation.projectPods.map((project) => (
            <ProjectSection
              key={project.projectId}
              project={project}
              agentMap={agentMap}
              liveCountByAgent={liveCountByAgent}
              activeAgentId={activeAgentId}
              activeTab={activeTab}
              depth={1}
              {...accordionFolderControl(project.projectId, projectPodOpenKey, setProjectPodOpenKey)}
            />
          ))}
        </HierarchyFolder>
      ) : null}

      {navigation.sharedServices.length > 0 ? (
        <HierarchyFolder
          label="Shared Services"
          count={navigation.sharedServices.reduce((sum, department) => sum + countDepartment(department), 0)}
          defaultOpen={false}
          autoOpen={navigation.sharedServices.some((department) => departmentHasActiveMember(department, activeAgentId))}
          {...accordionFolderControl("shared-services", topLevelOpenKey, setTopLevelOpenKey)}
        >
          {navigation.sharedServices.map((department) => (
            <DepartmentSection
              key={`${department.key}:${department.name}`}
              department={department}
              agentMap={agentMap}
              liveCountByAgent={liveCountByAgent}
              activeAgentId={activeAgentId}
              activeTab={activeTab}
              depth={1}
              {...accordionFolderControl(`${department.key}:${department.name}`, sharedServiceOpenKey, setSharedServiceOpenKey)}
            />
          ))}
        </HierarchyFolder>
      ) : null}

      {navigation.unassigned.length > 0 ? (
        <HierarchyFolder
          label="Unassigned"
          count={navigation.unassigned.length}
          defaultOpen={false}
          autoOpen={hasActiveMember(navigation.unassigned, activeAgentId)}
          {...accordionFolderControl("unassigned", topLevelOpenKey, setTopLevelOpenKey)}
        >
          <MemberList
            members={navigation.unassigned}
            agentMap={agentMap}
            liveCountByAgent={liveCountByAgent}
            activeAgentId={activeAgentId}
            activeTab={activeTab}
            depth={1}
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

  const [layout, setLayout] = useState<AgentLayoutMode>("accountability");

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
    queryKey: queryKeys.agents.navigation(selectedCompanyId!, layout === "accountability" ? "department" : layout),
    queryFn: () => agentsApi.navigation(selectedCompanyId!, layout === "accountability" ? "department" : layout),
    enabled: !!selectedCompanyId && layout !== "accountability",
  });
  const { data: accountability } = useQuery({
    queryKey: queryKeys.agents.accountability(selectedCompanyId!),
    queryFn: () => agentsApi.accountability(selectedCompanyId!),
    enabled: !!selectedCompanyId && layout === "accountability",
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

  function updateLayout(next: AgentLayoutMode) {
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
        {layout === "accountability" && accountability ? (
          <AccountabilityContent
            accountability={accountability}
            agentMap={agentMap}
            liveCountByAgent={liveCountByAgent}
            activeAgentId={activeAgentId}
            activeTab={activeTab}
          />
        ) : navigation ? (
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

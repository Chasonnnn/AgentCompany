import { type ReactNode, useEffect, useMemo, useState } from "react";
import { NavLink, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, FolderTree, Plus } from "lucide-react";
import {
  AGENT_ROLE_LABELS,
  type AccountabilityProjectNode,
  type Agent,
  type AgentHierarchyMemberSummary,
  type CompanyAgentAccountability,
  type OperatingHierarchyDepartmentSummary,
  type OperatingHierarchyProjectSummary,
} from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { SIDEBAR_SCROLL_RESET_STATE } from "../lib/navigation-scroll";
import { queryKeys } from "../lib/queryKeys";
import {
  buildSharedServiceLeadDepartmentsFromAccountability,
  buildSharedSpecialistPoolFromAccountability,
  countSharedSpecialists,
  type SharedSpecialistPoolEntry,
} from "../lib/shared-specialists";
import { agentRouteRef, agentUrl, cn } from "../lib/utils";
import { AgentIcon } from "./AgentIconPicker";
import { BudgetSidebarMarker } from "./BudgetSidebarMarker";
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
  const [manualOpen, setManualOpen] = useState<boolean | undefined>(undefined);
  const effectiveOpen = open ?? manualOpen ?? (autoOpen || defaultOpen);
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
  subtitle,
  depth = 0,
}: {
  summary: AgentHierarchyMemberSummary;
  agent: Agent | null;
  activeAgentId: string | null;
  activeTab: string | null;
  runCount: number;
  subtitle?: string | null;
  depth?: number;
}) {
  const { isMobile, setSidebarOpen } = useSidebar();
  const target = agent ?? summary;
  const hasSubtitle = Boolean(subtitle);
  return (
    <NavLink
      to={activeTab ? `${agentUrl(target)}/${activeTab}` : agentUrl(target)}
      state={SIDEBAR_SCROLL_RESET_STATE}
      onClick={() => {
        if (isMobile) setSidebarOpen(false);
      }}
      className={cn(
        "flex gap-2.5 py-1.5 pr-3 text-[13px] font-medium transition-colors",
        hasSubtitle ? "items-start" : "items-center",
        activeAgentId === agentRouteRef(target)
          ? "bg-accent text-foreground"
          : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
      )}
      style={{ paddingLeft: 12 + depth * 16 }}
    >
      <AgentIcon
        icon={agent?.icon ?? summary.icon}
        className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground", hasSubtitle && "mt-0.5")}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate">{summary.name}</div>
        {subtitle ? (
          <div className="truncate text-[11px] font-normal text-muted-foreground">
            {subtitle}
          </div>
        ) : null}
      </div>
      {((agent?.pauseReason ?? null) === "budget" || runCount > 0) && (
        <span className={cn("ml-auto flex shrink-0 items-center gap-1.5", hasSubtitle && "pt-0.5")}>
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
  subtitleByAgentId,
  depth = 0,
}: {
  members: AgentHierarchyMemberSummary[];
  agentMap: Map<string, Agent>;
  liveCountByAgent: Map<string, number>;
  activeAgentId: string | null;
  activeTab: string | null;
  subtitleByAgentId?: ReadonlyMap<string, string>;
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
          subtitle={subtitleByAgentId?.get(summary.id) ?? null}
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

function memberRoleSubtitle(member: Pick<AgentHierarchyMemberSummary, "role" | "title">) {
  return `${AGENT_ROLE_LABELS[member.role] ?? member.role}${member.title ? ` - ${member.title}` : ""}`;
}

function sharedSpecialistSubtitle(entry: SharedSpecialistPoolEntry) {
  return `${memberRoleSubtitle(entry.member)} · ${entry.homeTeamLabel}`;
}

function operatingProjectHasActiveMember(
  project: Pick<OperatingHierarchyProjectSummary, "leadership" | "workers" | "consultants">,
  activeAgentId: string | null,
) {
  return hasActiveMember(project.leadership, activeAgentId)
    || hasActiveMember(project.workers, activeAgentId)
    || hasActiveMember(project.consultants, activeAgentId);
}

function countOperatingProject(project: Pick<OperatingHierarchyProjectSummary, "leadership" | "workers" | "consultants">) {
  return countMembers(project.leadership)
    + countMembers(project.workers)
    + countMembers(project.consultants);
}

function countSharedServiceDepartment(department: OperatingHierarchyDepartmentSummary) {
  return countMembers(department.leaders)
    + department.projects.reduce((sum, project) => sum + countOperatingProject(project), 0);
}

function sharedServiceDepartmentHasActiveMember(
  department: OperatingHierarchyDepartmentSummary,
  activeAgentId: string | null,
) {
  return hasActiveMember(department.leaders, activeAgentId)
    || department.projects.some((project) => operatingProjectHasActiveMember(project, activeAgentId));
}

function accountabilityProjectHasActiveMember(project: AccountabilityProjectNode, activeAgentId: string | null) {
  return hasActiveMember(flattenAllAccountabilityProjectMembers(project), activeAgentId);
}

function countAccountabilityProjectMembers(project: AccountabilityProjectNode) {
  return flattenAccountabilityProjectMembers(project).length;
}

function isVisibleAccountabilityProject(
  project: AccountabilityProjectNode,
): project is AccountabilityProjectNode & { projectId: string } {
  return project.projectId !== null;
}

function visibleAccountabilityProjects(
  accountability: CompanyAgentAccountability,
): Array<AccountabilityProjectNode & { projectId: string }> {
  return accountability.projects.filter(isVisibleAccountabilityProject);
}

function flattenAccountabilityProjectMembers(project: AccountabilityProjectNode): AgentHierarchyMemberSummary[] {
  const primaryLead = project.projectLead ? [project.projectLead] : [];
  const fallbackLeadership = project.projectLead ? [] : project.leadership;
  return flattenAccountabilityMemberGroups([
    primaryLead,
    fallbackLeadership,
    project.continuityOwners,
    project.sharedServices,
  ]);
}

function flattenAllAccountabilityProjectMembers(project: AccountabilityProjectNode): AgentHierarchyMemberSummary[] {
  const members: AgentHierarchyMemberSummary[] = [];
  const primaryLead = project.projectLead ? [project.projectLead] : [];
  const fallbackLeadership = project.projectLead ? [] : project.leadership;
  return flattenAccountabilityMemberGroups([
    primaryLead,
    fallbackLeadership,
    project.continuityOwners,
    project.executiveIssueOwners,
    project.sharedServices,
  ]);
}

function flattenAccountabilityMemberGroups(groups: readonly AgentHierarchyMemberSummary[][]) {
  const members: AgentHierarchyMemberSummary[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const member of group) {
      if (seen.has(member.id)) continue;
      seen.add(member.id);
      members.push(member);
    }
  }
  return members;
}

function formatActiveIssueCount(count: number) {
  return `${count} active issue${count === 1 ? "" : "s"}`;
}

function useSingleOpenBranch(activeKey: string | null) {
  const [manualState, setManualState] = useState<{ key: string | null; touched: boolean }>({
    key: null,
    touched: false,
  });
  useEffect(() => {
    setManualState({ key: null, touched: false });
  }, [activeKey]);
  return {
    openKey: manualState.touched ? manualState.key : activeKey,
    setOpenKey: (key: string | null) => setManualState({ key, touched: true }),
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
  const activeBranchKey = hasActiveMember(project.leadership, activeAgentId)
    ? "leadership"
    : hasActiveMember(project.workers, activeAgentId)
      ? "workers"
      : hasActiveMember(project.consultants, activeAgentId)
        ? "shared-services"
        : null;
  const { openKey, setOpenKey } = useSingleOpenBranch(activeBranchKey);
  if (project.leadership.length === 0 && project.workers.length === 0 && project.consultants.length === 0) {
    return null;
  }

  return (
    <HierarchyFolder
      label={project.projectName}
      count={countOperatingProject(project)}
      depth={depth}
      defaultOpen={false}
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
        defaultOpen={false}
        {...accordionFolderControl("workers", openKey, setOpenKey)}
      />
      <MemberSection
        label="Shared Services"
        members={project.consultants}
        agentMap={agentMap}
        liveCountByAgent={liveCountByAgent}
        activeAgentId={activeAgentId}
        activeTab={activeTab}
        parentDepth={depth}
        defaultOpen={false}
        {...accordionFolderControl("shared-services", openKey, setOpenKey)}
      />
    </HierarchyFolder>
  );
}

function AccountabilityProjectSection({
  project,
  agentMap,
  liveCountByAgent,
  activeAgentId,
  activeTab,
  depth,
  open,
  onOpenChange,
}: {
  project: AccountabilityProjectNode;
  agentMap: Map<string, Agent>;
  liveCountByAgent: Map<string, number>;
  activeAgentId: string | null;
  activeTab: string | null;
  depth: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const members = flattenAccountabilityProjectMembers(project);
  if (members.length === 0 && project.executiveIssueOwners.length === 0) {
    return null;
  }

  return (
    <HierarchyFolder
      label={project.projectName}
      count={countAccountabilityProjectMembers(project)}
      depth={depth}
      autoOpen={accountabilityProjectHasActiveMember(project, activeAgentId)}
      open={open}
      onOpenChange={onOpenChange}
    >
      {project.executiveSponsor ? (
        <div
          className="px-3 py-1 text-[11px] text-muted-foreground/80"
          style={{ paddingLeft: 12 + (depth + 1) * 16 }}
        >
          Sponsor: <span className="text-foreground/80">{project.executiveSponsor.name}</span>
        </div>
      ) : null}
      {project.executiveIssueOwners.length > 0 ? (
        <div
          className="px-3 py-1.5 text-[11px] text-muted-foreground/80"
          style={{ paddingLeft: 12 + (depth + 1) * 16 }}
        >
          <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70">
            Executive continuity owners
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {project.executiveIssueOwners.map((owner) => (
              <span
                key={owner.id}
                className="rounded border border-border/70 bg-muted/30 px-1.5 py-0.5 text-[10px] text-foreground/80"
              >
                {owner.name} · {formatActiveIssueCount(owner.activeIssueCount)}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {members.length > 0 ? (
        <MemberList
          members={members}
          agentMap={agentMap}
          liveCountByAgent={liveCountByAgent}
          activeAgentId={activeAgentId}
          activeTab={activeTab}
          depth={depth + 1}
        />
      ) : null}
    </HierarchyFolder>
  );
}

function SharedServiceDepartmentSection({
  department,
  agentMap,
  liveCountByAgent,
  activeAgentId,
  activeTab,
  open,
  onOpenChange,
}: {
  department: OperatingHierarchyDepartmentSummary;
  agentMap: Map<string, Agent>;
  liveCountByAgent: Map<string, number>;
  activeAgentId: string | null;
  activeTab: string | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const activeProject = department.projects.find((project) => operatingProjectHasActiveMember(project, activeAgentId));
  const activeBranchKey = hasActiveMember(department.leaders, activeAgentId)
    ? "leadership"
    : activeProject
      ? `project:${activeProject.projectId}`
      : null;
  const { openKey, setOpenKey } = useSingleOpenBranch(activeBranchKey);
  if (department.leaders.length === 0 && department.projects.length === 0) return null;

  return (
    <HierarchyFolder
      label={department.name}
      count={countSharedServiceDepartment(department)}
      depth={1}
      autoOpen={sharedServiceDepartmentHasActiveMember(department, activeAgentId)}
      open={open}
      onOpenChange={onOpenChange}
    >
      <MemberSection
        label="Leadership"
        members={department.leaders}
        agentMap={agentMap}
        liveCountByAgent={liveCountByAgent}
        activeAgentId={activeAgentId}
        activeTab={activeTab}
        parentDepth={1}
        {...accordionFolderControl("leadership", openKey, setOpenKey)}
      />
      {department.projects.map((project) => (
        <OperatingProjectSection
          key={`${department.key}:${project.projectId}`}
          project={project}
          agentMap={agentMap}
          liveCountByAgent={liveCountByAgent}
          activeAgentId={activeAgentId}
          activeTab={activeTab}
          depth={2}
          {...accordionFolderControl(`project:${project.projectId}`, openKey, setOpenKey)}
        />
      ))}
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
  const projects = visibleAccountabilityProjects(accountability);
  const sharedSpecialists = buildSharedSpecialistPoolFromAccountability(accountability);
  const sharedServiceDepartments = buildSharedServiceLeadDepartmentsFromAccountability(accountability);
  const sharedSpecialistMembers = sharedSpecialists.map((entry) => entry.member);
  const sharedSpecialistSubtitleByAgentId = new Map(
    sharedSpecialists.map((entry) => [entry.member.id, sharedSpecialistSubtitle(entry)]),
  );
  const activeProject = projects.find((project) =>
    accountabilityProjectHasActiveMember(project, activeAgentId),
  );
  const activeSharedService = sharedServiceDepartments.find((department) =>
    sharedServiceDepartmentHasActiveMember(department, activeAgentId),
  );
  const activeProjectKey = activeProject ? activeProject.projectId ?? activeProject.projectName : null;
  const { openKey: projectOpenKey, setOpenKey: setProjectOpenKey } = useSingleOpenBranch(activeProjectKey);
  const activeSharedServiceKey = activeSharedService ? `${activeSharedService.key}:${activeSharedService.name}` : null;
  const { openKey: sharedServiceOpenKey, setOpenKey: setSharedServiceOpenKey } = useSingleOpenBranch(activeSharedServiceKey);

  return (
    <div className="mt-0.5 flex flex-col gap-1">
      {accountability.executiveOffice.length > 0 ? (
        <HierarchyFolder
          label="Executive Office"
          count={accountability.executiveOffice.length}
          autoOpen={hasActiveMember(accountability.executiveOffice, activeAgentId)}
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

      {projects.map((project) => (
        <AccountabilityProjectSection
          key={project.projectId}
          project={project}
          agentMap={agentMap}
          liveCountByAgent={liveCountByAgent}
          activeAgentId={activeAgentId}
          activeTab={activeTab}
          depth={0}
          {...accordionFolderControl(project.projectId, projectOpenKey, setProjectOpenKey)}
        />
      ))}

      {sharedSpecialists.length > 0 ? (
        <HierarchyFolder
          label="Consulting Team"
          count={countSharedSpecialists(sharedSpecialists)}
          defaultOpen={false}
          autoOpen={hasActiveMember(sharedSpecialistMembers, activeAgentId)}
        >
          <MemberList
            members={sharedSpecialistMembers}
            agentMap={agentMap}
            liveCountByAgent={liveCountByAgent}
            activeAgentId={activeAgentId}
            activeTab={activeTab}
            subtitleByAgentId={sharedSpecialistSubtitleByAgentId}
            depth={1}
          />
        </HierarchyFolder>
      ) : null}

      {sharedServiceDepartments.length > 0 ? (
        <HierarchyFolder
          label="Shared Services"
          count={sharedServiceDepartments.reduce((sum, department) => sum + countSharedServiceDepartment(department), 0)}
          defaultOpen={false}
          autoOpen={sharedServiceDepartments.some((department) => sharedServiceDepartmentHasActiveMember(department, activeAgentId))}
        >
          {sharedServiceDepartments.map((department) => (
            <SharedServiceDepartmentSection
              key={`${department.key}:${department.name}`}
              department={department}
              agentMap={agentMap}
              liveCountByAgent={liveCountByAgent}
              activeAgentId={activeAgentId}
              activeTab={activeTab}
              {...accordionFolderControl(`${department.key}:${department.name}`, sharedServiceOpenKey, setSharedServiceOpenKey)}
            />
          ))}
        </HierarchyFolder>
      ) : null}

      {accountability.unassigned.length > 0 ? (
        <HierarchyFolder
          label="Needs Scope"
          count={accountability.unassigned.length}
          defaultOpen={false}
          autoOpen={hasActiveMember(accountability.unassigned, activeAgentId)}
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

export function SidebarAgents() {
  const [open, setOpen] = useState(true);
  const { selectedCompanyId } = useCompany();
  const { openNewAgent } = useDialog();
  const location = useLocation();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: accountability } = useQuery({
    queryKey: queryKeys.agents.accountability(selectedCompanyId!),
    queryFn: () => agentsApi.accountability(selectedCompanyId!),
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
        {accountability ? (
          <AccountabilityContent
            accountability={accountability}
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

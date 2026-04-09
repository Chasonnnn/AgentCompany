import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import {
  AGENT_DEPARTMENT_LABELS,
  AGENT_ROLE_LABELS,
  type Agent,
  type AgentHierarchyMemberSummary,
  type CompanyAgentHierarchy,
} from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
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

function filterMembers(
  members: AgentHierarchyMemberSummary[],
  tab: FilterTab,
  showTerminated: boolean,
) {
  return members
    .filter((member) => matchesFilter(member.status, tab, showTerminated))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function filterHierarchy(
  hierarchy: CompanyAgentHierarchy,
  tab: FilterTab,
  showTerminated: boolean,
): CompanyAgentHierarchy {
  return {
    executives: hierarchy.executives
      .map((group) => ({
        executive: group.executive,
        departments: group.departments
          .map((department) => ({
            ...department,
            directors: filterMembers(department.directors, tab, showTerminated),
            staff: filterMembers(department.staff, tab, showTerminated),
          }))
          .filter((department) => department.directors.length > 0 || department.staff.length > 0),
      }))
      .filter(
        (group) =>
          matchesFilter(group.executive.status, tab, showTerminated) || group.departments.length > 0,
      ),
    unassigned: {
      executives: filterMembers(hierarchy.unassigned.executives, tab, showTerminated),
      directors: filterMembers(hierarchy.unassigned.directors, tab, showTerminated),
      staff: filterMembers(hierarchy.unassigned.staff, tab, showTerminated),
    },
  };
}

function hierarchyCount(hierarchy: CompanyAgentHierarchy) {
  return (
    hierarchy.executives.reduce(
      (total, group) =>
        total +
        1 +
        group.departments.reduce(
          (departmentTotal, department) => departmentTotal + department.directors.length + department.staff.length,
          0,
        ),
      0,
    ) +
    hierarchy.unassigned.executives.length +
    hierarchy.unassigned.directors.length +
    hierarchy.unassigned.staff.length
  );
}

function levelLabel(level: string) {
  if (level === "executive") return "Executive";
  if (level === "director") return "Director";
  return "Staff";
}

function HierarchyMemberRow({
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

function DepartmentBlock({
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
          <HierarchyMemberRow
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
  const [view, setView] = useState<"list" | "hierarchy">("hierarchy");
  const forceListView = isMobile;
  const effectiveView = forceListView ? "list" : view;
  const [showTerminated, setShowTerminated] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const { data: agents, isLoading, error } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: hierarchy } = useQuery({
    queryKey: queryKeys.agents.hierarchy(selectedCompanyId!),
    queryFn: () => agentsApi.hierarchy(selectedCompanyId!),
    enabled: !!selectedCompanyId && effectiveView === "hierarchy",
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
  const filteredHierarchy = hierarchy ? filterHierarchy(hierarchy, tab, showTerminated) : null;
  const filteredHierarchyCount = filteredHierarchy ? hierarchyCount(filteredHierarchy) : 0;

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
                  effectiveView === "hierarchy"
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/50",
                )}
                onClick={() => setView("hierarchy")}
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
      {effectiveView === "hierarchy" && filteredHierarchy ? (
        <p className="text-xs text-muted-foreground">
          {filteredHierarchyCount} agent{filteredHierarchyCount !== 1 ? "s" : ""} in hierarchy
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

      {effectiveView === "hierarchy" && filteredHierarchy && filteredHierarchyCount > 0 ? (
        <div className="space-y-6">
          {filteredHierarchy.executives.map((group) => (
            <section key={group.executive.id} className="space-y-3">
              <div className="rounded-xl border border-border bg-card p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                      Executive
                    </div>
                    <Link
                      to={agentUrl(agentMap.get(group.executive.id) ?? ({
                        ...group.executive,
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
                      } as Agent))}
                      className="text-lg font-semibold hover:underline"
                    >
                      {group.executive.name}
                    </Link>
                    <p className="text-sm text-muted-foreground">
                      {AGENT_ROLE_LABELS[group.executive.role] ?? group.executive.role}
                      {group.executive.title ? ` - ${group.executive.title}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground">
                      {levelLabel(group.executive.orgLevel)}
                    </span>
                    <span className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground">
                      {group.executive.departmentKey === "custom"
                        ? group.executive.departmentName ?? "Custom"
                        : AGENT_DEPARTMENT_LABELS[group.executive.departmentKey]}
                    </span>
                    <StatusBadge status={group.executive.status} />
                  </div>
                </div>
              </div>

              {group.departments.map((department) => (
                <section key={`${group.executive.id}-${department.key}-${department.name}`} className="space-y-3">
                  <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                    {department.name}
                  </div>
                  <DepartmentBlock
                    label="Directors"
                    members={department.directors}
                    agentMap={agentMap}
                    liveRunByAgent={liveRunByAgent}
                  />
                  <DepartmentBlock
                    label="Staff"
                    members={department.staff}
                    agentMap={agentMap}
                    liveRunByAgent={liveRunByAgent}
                  />
                </section>
              ))}
            </section>
          ))}

          {filteredHierarchy.unassigned.executives.length > 0 ||
          filteredHierarchy.unassigned.directors.length > 0 ||
          filteredHierarchy.unassigned.staff.length > 0 ? (
            <section className="space-y-3">
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                Unassigned
              </div>
              <DepartmentBlock
                label="Executives"
                members={filteredHierarchy.unassigned.executives}
                agentMap={agentMap}
                liveRunByAgent={liveRunByAgent}
              />
              <DepartmentBlock
                label="Directors"
                members={filteredHierarchy.unassigned.directors}
                agentMap={agentMap}
                liveRunByAgent={liveRunByAgent}
              />
              <DepartmentBlock
                label="Staff"
                members={filteredHierarchy.unassigned.staff}
                agentMap={agentMap}
                liveRunByAgent={liveRunByAgent}
              />
            </section>
          ) : null}
        </div>
      ) : null}

      {effectiveView === "hierarchy" && filteredHierarchy && filteredHierarchyCount === 0 ? (
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

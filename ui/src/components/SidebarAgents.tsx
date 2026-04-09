import { useMemo, useState } from "react";
import { NavLink, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, FolderTree, Plus } from "lucide-react";
import type {
  Agent,
  AgentHierarchyMemberSummary,
  CompanyAgentHierarchy,
  CompanyAgentHierarchyDepartment,
} from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { queryKeys } from "../lib/queryKeys";
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
  defaultOpen = true,
  depth = 0,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  depth?: number;
  children: React.ReactNode;
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

function DepartmentSection({
  department,
  activeAgentId,
  activeTab,
  agentMap,
  liveCountByAgent,
  depth,
}: {
  department: CompanyAgentHierarchyDepartment;
  activeAgentId: string | null;
  activeTab: string | null;
  agentMap: Map<string, Agent>;
  liveCountByAgent: Map<string, number>;
  depth: number;
}) {
  const directorCount = department.directors.length;
  const staffCount = department.staff.length;
  if (directorCount === 0 && staffCount === 0) return null;

  return (
    <HierarchyFolder label={department.name} depth={depth}>
      {directorCount > 0 ? (
        <HierarchyFolder label="Directors" depth={depth + 1}>
          <div className="flex flex-col gap-0.5">
            {department.directors.map((summary) => (
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
        </HierarchyFolder>
      ) : null}
      {staffCount > 0 ? (
        <HierarchyFolder label="Staff" depth={depth + 1} defaultOpen={false}>
          <div className="flex flex-col gap-0.5">
            {department.staff.map((summary) => (
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
        </HierarchyFolder>
      ) : null}
    </HierarchyFolder>
  );
}

function HierarchyContent({
  hierarchy,
  agentMap,
  liveCountByAgent,
  activeAgentId,
  activeTab,
}: {
  hierarchy: CompanyAgentHierarchy;
  agentMap: Map<string, Agent>;
  liveCountByAgent: Map<string, number>;
  activeAgentId: string | null;
  activeTab: string | null;
}) {
  return (
    <div className="mt-0.5 flex flex-col gap-1">
      <HierarchyFolder label="Executives">
        <div className="flex flex-col gap-1">
          {hierarchy.executives.map((group) => (
            <HierarchyFolder key={group.executive.id} label={group.executive.name} depth={1}>
              <div className="flex flex-col gap-0.5">
                <SidebarAgentLink
                  summary={group.executive}
                  agent={agentMap.get(group.executive.id) ?? null}
                  activeAgentId={activeAgentId}
                  activeTab={activeTab}
                  runCount={liveCountByAgent.get(group.executive.id) ?? 0}
                />
              </div>
              {group.departments.map((department) => (
                <DepartmentSection
                  key={`${group.executive.id}-${department.key}-${department.name}`}
                  department={department}
                  activeAgentId={activeAgentId}
                  activeTab={activeTab}
                  agentMap={agentMap}
                  liveCountByAgent={liveCountByAgent}
                  depth={2}
                />
              ))}
            </HierarchyFolder>
          ))}
        </div>
      </HierarchyFolder>

      {(hierarchy.unassigned.executives.length > 0 ||
        hierarchy.unassigned.directors.length > 0 ||
        hierarchy.unassigned.staff.length > 0) ? (
        <HierarchyFolder label="Unassigned" defaultOpen={false}>
          {hierarchy.unassigned.executives.length > 0 ? (
            <HierarchyFolder label="Executives" depth={1}>
              <div className="flex flex-col gap-0.5">
                {hierarchy.unassigned.executives.map((summary) => (
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
            </HierarchyFolder>
          ) : null}
          {hierarchy.unassigned.directors.length > 0 ? (
            <HierarchyFolder label="Directors" depth={1}>
              <div className="flex flex-col gap-0.5">
                {hierarchy.unassigned.directors.map((summary) => (
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
            </HierarchyFolder>
          ) : null}
          {hierarchy.unassigned.staff.length > 0 ? (
            <HierarchyFolder label="Staff" depth={1}>
              <div className="flex flex-col gap-0.5">
                {hierarchy.unassigned.staff.map((summary) => (
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
            </HierarchyFolder>
          ) : null}
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
  const { data: hierarchy } = useQuery({
    queryKey: queryKeys.agents.hierarchy(selectedCompanyId!),
    queryFn: () => agentsApi.hierarchy(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });

  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  void currentUserId;

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
        {hierarchy ? (
          <HierarchyContent
            hierarchy={hierarchy}
            agentMap={agentMap}
            liveCountByAgent={liveCountByAgent}
            activeAgentId={activeAgentId}
            activeTab={activeTab}
          />
        ) : (
          <div className="px-3 py-2 text-xs text-muted-foreground">Loading hierarchy…</div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

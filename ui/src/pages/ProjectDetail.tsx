import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { Link, useParams, useNavigate, useLocation, Navigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  PROJECT_COLORS,
  PROJECT_RESERVED_DOCUMENT_KEYS,
  getReservedProjectDocumentDescriptor,
  isUuidLike,
  type BudgetOverview,
  type BudgetPolicySummary,
} from "@paperclipai/shared";
import { budgetsApi } from "../api/budgets";
import { companiesApi } from "../api/companies";
import { conferenceRoomsApi } from "../api/conferenceRooms";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { goalsApi } from "../api/goals";
import { instanceSettingsApi } from "../api/instanceSettings";
import { projectsApi } from "../api/projects";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { routinesApi } from "../api/routines";
import { assetsApi } from "../api/assets";
import { ApiError } from "../api/client";
import { usePanel } from "../context/PanelContext";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { ProjectProperties, type ProjectConfigFieldKey, type ProjectFieldSaveState } from "../components/ProjectProperties";
import { InlineEditor } from "../components/InlineEditor";
import { StatusBadge } from "../components/StatusBadge";
import { BudgetPolicyCard } from "../components/BudgetPolicyCard";
import { IssuesList } from "../components/IssuesList";
import { PageSkeleton } from "../components/PageSkeleton";
import { PageTabBar } from "../components/PageTabBar";
import { ProjectWorkspacesContent } from "../components/ProjectWorkspacesContent";
import { buildProjectWorkspaceSummaries } from "../lib/project-workspaces-tab";
import { projectRouteRef } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";
import {
  ONBOARDING_BRANCH_TITLE,
  ONBOARDING_DEMO_TITLES,
  ONBOARDING_KICKOFF_ROOM_TITLE,
  ONBOARDING_ROUTINE_TITLES,
  STARTER_AGENT_NAMES,
} from "../lib/onboarding-bootstrap";
import { ONBOARDING_PROJECT_NAME } from "../lib/onboarding-launch";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { PluginSlotMount, PluginSlotOutlet, usePluginSlots } from "@/plugins/slots";

/* ── Top-level tab types ── */

type ProjectBaseTab = "overview" | "list" | "workspaces" | "context" | "configuration" | "budget";
type ProjectPluginTab = `plugin:${string}`;
type ProjectTab = ProjectBaseTab | ProjectPluginTab;

function isProjectPluginTab(value: string | null): value is ProjectPluginTab {
  return typeof value === "string" && value.startsWith("plugin:");
}

function resolveProjectTab(pathname: string, projectId: string): ProjectTab | null {
  const segments = pathname.split("/").filter(Boolean);
  const projectsIdx = segments.indexOf("projects");
  if (projectsIdx === -1 || segments[projectsIdx + 1] !== projectId) return null;
  const tab = segments[projectsIdx + 2];
  if (tab === "overview") return "overview";
  if (tab === "context") return "context";
  if (tab === "configuration") return "configuration";
  if (tab === "budget") return "budget";
  if (tab === "issues") return "list";
  if (tab === "workspaces") return "workspaces";
  return null;
}

/* ── Overview tab content ── */

function OverviewContent({
  project,
  onUpdate,
  imageUploadHandler,
}: {
  project: { description: string | null; status: string; targetDate: string | null };
  onUpdate: (data: Record<string, unknown>) => void;
  imageUploadHandler?: (file: File) => Promise<string>;
}) {
  return (
    <div className="space-y-6">
      <InlineEditor
        value={project.description ?? ""}
        onSave={(description) => onUpdate({ description })}
        nullable
        as="p"
        className="text-sm text-muted-foreground"
        placeholder="Add a description..."
        multiline
        imageUploadHandler={imageUploadHandler}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
        <div>
          <span className="text-muted-foreground">Status</span>
          <div className="mt-1">
            <StatusBadge status={project.status} />
          </div>
        </div>
        {project.targetDate && (
          <div>
            <span className="text-muted-foreground">Target Date</span>
            <p>{project.targetDate}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function OnboardingReadinessCard({
  project,
  companyId,
  budgetOverview,
}: {
  project: { id: string; name: string; goalIds: string[] };
  companyId: string;
  budgetOverview?: BudgetOverview;
}) {
  const companyQuery = useQuery({
    queryKey: queryKeys.companies.detail(companyId),
    queryFn: () => companiesApi.get(companyId),
    enabled: project.name === ONBOARDING_PROJECT_NAME,
  });
  const goalsQuery = useQuery({
    queryKey: queryKeys.goals.list(companyId),
    queryFn: () => goalsApi.list(companyId),
    enabled: project.name === ONBOARDING_PROJECT_NAME,
  });
  const companyDocsQuery = useQuery({
    queryKey: queryKeys.companies.documents(companyId),
    queryFn: () => companiesApi.listDocuments(companyId),
    enabled: project.name === ONBOARDING_PROJECT_NAME,
  });
  const teamDocsQuery = useQuery({
    queryKey: queryKeys.companies.teamDocuments(companyId),
    queryFn: () => companiesApi.listTeamDocuments(companyId),
    enabled: project.name === ONBOARDING_PROJECT_NAME,
  });
  const projectDocsQuery = useQuery({
    queryKey: queryKeys.projects.documents(project.id),
    queryFn: () => projectsApi.listDocuments(project.id, companyId),
    enabled: project.name === ONBOARDING_PROJECT_NAME,
  });
  const routinesQuery = useQuery({
    queryKey: queryKeys.routines.list(companyId),
    queryFn: () => routinesApi.list(companyId),
    enabled: project.name === ONBOARDING_PROJECT_NAME,
  });
  const roomsQuery = useQuery({
    queryKey: queryKeys.conferenceRooms.list(companyId),
    queryFn: () => conferenceRoomsApi.list(companyId),
    enabled: project.name === ONBOARDING_PROJECT_NAME,
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: project.name === ONBOARDING_PROJECT_NAME,
  });
  const issuesQuery = useQuery({
    queryKey: queryKeys.issues.listByProject(companyId, project.id),
    queryFn: () => issuesApi.list(companyId, { projectId: project.id }),
    enabled: project.name === ONBOARDING_PROJECT_NAME,
  });

  if (project.name !== ONBOARDING_PROJECT_NAME) return null;

  if (
    goalsQuery.isLoading ||
    companyDocsQuery.isLoading ||
    teamDocsQuery.isLoading ||
    projectDocsQuery.isLoading ||
    routinesQuery.isLoading ||
    roomsQuery.isLoading ||
    companyQuery.isLoading ||
    agentsQuery.isLoading ||
    issuesQuery.isLoading
  ) {
    return (
      <div className="rounded-lg border border-border px-4 py-4 text-sm text-muted-foreground">
        Loading onboarding readiness...
      </div>
    );
  }

  const companyGoals = (goalsQuery.data ?? []).filter((goal) => goal.level === "company");
  const companyDocExists = (companyDocsQuery.data ?? []).some((document) => document.key === "company");
  const teamDocs = teamDocsQuery.data ?? [];
  const projectDocs = projectDocsQuery.data ?? [];
  const routines = routinesQuery.data ?? [];
  const rooms = roomsQuery.data ?? [];
  const agents = agentsQuery.data ?? [];
  const issues = issuesQuery.data ?? [];
  const company = companyQuery.data ?? null;
  const projectBudget = budgetOverview?.policies.find(
    (policy) => policy.scopeType === "project" && policy.scopeId === project.id,
  );
  const starterAgentNames = [
    STARTER_AGENT_NAMES.ceo,
    STARTER_AGENT_NAMES.officeOperator,
    STARTER_AGENT_NAMES.technicalProjectLead,
    STARTER_AGENT_NAMES.backendContinuityOwner,
    STARTER_AGENT_NAMES.qaEvalsContinuityOwner,
  ] as const;
  const starterAgents = agents.filter((agent) => starterAgentNames.some((name) => name === agent.name));

  const items = [
    { label: "Company goal exists", ready: companyGoals.length > 0 },
    { label: "Onboarding project goal linked", ready: project.goalIds.length > 0 },
    { label: "COMPANY.md exists", ready: companyDocExists },
    {
      label: "Project docs exist",
      ready: PROJECT_RESERVED_DOCUMENT_KEYS.every((key) => projectDocs.some((document) => document.key === key)),
    },
    {
      label: "Relevant TEAM.md docs exist",
      ready:
        teamDocs.some((document) => document.departmentKey === "engineering" && document.key === "team")
        && teamDocs.some((document) => document.departmentKey === "operations" && document.key === "team")
        && teamDocs.some((document) => document.departmentKey === "research" && document.key === "team")
        && teamDocs.some((document) => document.departmentKey === "marketing" && document.key === "team"),
    },
    {
      label: "Kickoff room exists",
      ready: rooms.some((room) => room.title === ONBOARDING_KICKOFF_ROOM_TITLE),
    },
    {
      label: "Baseline routines exist",
      ready: [
        ONBOARDING_ROUTINE_TITLES.dailyReadiness,
        ONBOARDING_ROUTINE_TITLES.weeklyBudgetAudit,
        ONBOARDING_ROUTINE_TITLES.weeklyKickoffRiskReview,
      ].every((title) => routines.some((routine) => routine.title === title)),
    },
    {
      label: "At least one worker heartbeat is enabled",
      ready: starterAgents.some((agent) => {
        const heartbeat = ((agent.runtimeConfig as Record<string, unknown> | null)?.heartbeat as Record<string, unknown> | null) ?? null;
        return heartbeat?.enabled === true;
      }),
    },
    {
      label: "Demo governance lane exists",
      ready: [
        ONBOARDING_BRANCH_TITLE,
        ONBOARDING_DEMO_TITLES.review,
        ONBOARDING_DEMO_TITLES.handoff,
      ].every((title) => issues.some((issue) => issue.title === title)),
    },
    {
      label: "Company and project budgets are non-zero",
      ready:
        (company?.budgetMonthlyCents ?? 0) > 0
        && (projectBudget?.amount ?? 0) > 0
        && starterAgents.length >= starterAgentNames.length,
    },
  ];
  const readyCount = items.filter((item) => item.ready).length;

  return (
    <div className="rounded-lg border border-border px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
            Enterprise bootstrap
          </div>
          <h3 className="text-lg font-semibold">Onboarding readiness</h3>
        </div>
        <div className="text-sm text-muted-foreground">
          {readyCount}/{items.length} ready
        </div>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {items.map((item) => (
          <div
            key={item.label}
            className="flex items-center gap-3 rounded-md border border-border px-3 py-2 text-sm"
          >
            <span className={`h-2.5 w-2.5 rounded-full ${item.ready ? "bg-emerald-500" : "bg-amber-500"}`} />
            <span>{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function projectDocumentTitle(key: string) {
  return `PROJECT_${key.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}.md`;
}

function ProjectDocumentsSection({
  projectId,
  companyId,
}: {
  projectId: string;
  companyId: string;
}) {
  const queryClient = useQueryClient();
  const [selectedKey, setSelectedKey] = useState<(typeof PROJECT_RESERVED_DOCUMENT_KEYS)[number]>("context");
  const [draft, setDraft] = useState("");
  const { data: summaries, isLoading: summariesLoading, error: summariesError } = useQuery({
    queryKey: queryKeys.projects.documents(projectId),
    queryFn: async () => projectsApi.listDocuments(projectId, companyId),
    enabled: Boolean(projectId && companyId),
  });
  const selectedDescriptor = getReservedProjectDocumentDescriptor(selectedKey);
  const selectedSummary = useMemo(
    () => summaries?.find((document) => document.key === selectedKey) ?? null,
    [selectedKey, summaries],
  );
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.projects.document(projectId, selectedKey),
    queryFn: async () => {
      try {
        return await projectsApi.getDocument(projectId, selectedKey, companyId);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    retry: false,
    enabled: Boolean(projectId && companyId),
  });

  const extraDocumentCount = (summaries ?? []).filter((document) =>
    !PROJECT_RESERVED_DOCUMENT_KEYS.includes(document.key as (typeof PROJECT_RESERVED_DOCUMENT_KEYS)[number]),
  ).length;

  useEffect(() => {
    setDraft(data?.body ?? "");
  }, [data?.body, data?.latestRevisionId, selectedKey]);

  const saveMutation = useMutation({
    mutationFn: async () =>
      projectsApi.upsertDocument(
        projectId,
        selectedKey,
        {
          title: projectDocumentTitle(selectedKey),
          format: "markdown",
          body: draft,
          baseRevisionId: data?.latestRevisionId ?? null,
        },
        companyId,
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.document(projectId, selectedKey) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.documents(projectId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.documentRevisions(projectId, selectedKey) }),
      ]);
    },
  });

  if (summariesLoading || isLoading) {
    return <p className="text-sm text-muted-foreground">Loading project docs...</p>;
  }
  if (summariesError || error) {
    return <p className="text-sm text-destructive">{((summariesError ?? error) as Error).message}</p>;
  }

  const unchanged = draft === (data?.body ?? "");

  return (
    <div className="max-w-4xl space-y-4">
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          {PROJECT_RESERVED_DOCUMENT_KEYS.map((key) => {
            const descriptor = getReservedProjectDocumentDescriptor(key);
            const exists = summaries?.some((document) => document.key === key);
            return (
              <Button
                key={key}
                type="button"
                variant={selectedKey === key ? "default" : "outline"}
                size="sm"
                onClick={() => setSelectedKey(key)}
              >
                {descriptor?.label ?? key}
                <span className="ml-2 text-xs opacity-70">{exists ? "saved" : "new"}</span>
              </Button>
            );
          })}
        </div>
        {extraDocumentCount > 0 ? (
          <p className="text-xs text-muted-foreground">
            {extraDocumentCount} non-reserved project doc{extraDocumentCount === 1 ? "" : "s"} exist outside this promoted set.
          </p>
        ) : null}
      </div>
      <div className="space-y-1">
        <h3 className="text-sm font-medium tracking-[0.18em] uppercase text-muted-foreground">
          {projectDocumentTitle(selectedKey)}
        </h3>
        <p className="text-sm text-muted-foreground">
          {selectedDescriptor?.description ?? "Leadership-curated project artifact."}
        </p>
        <p className="text-xs text-muted-foreground">{selectedDescriptor?.owner ?? "Project leadership"} curates this doc.</p>
        {data ? (
          <p className="text-xs text-muted-foreground">
            Revision {data.latestRevisionNumber}
            {data.updatedAt ? ` · Updated ${timeAgo(data.updatedAt)}` : ""}
          </p>
        ) : null}
      </div>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className="min-h-[320px] w-full rounded-lg border border-border bg-background px-4 py-3 font-mono text-sm"
        placeholder={selectedDescriptor?.description ?? "Document durable project state."}
      />
      <div className="flex items-center gap-3">
        <Button
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending || unchanged}
        >
          {saveMutation.isPending ? "Saving..." : selectedSummary ? `Save ${selectedDescriptor?.label ?? selectedKey}` : `Create ${selectedDescriptor?.label ?? selectedKey}`}
        </Button>
        {saveMutation.isError ? (
          <p className="text-sm text-destructive">{(saveMutation.error as Error).message}</p>
        ) : null}
        {saveMutation.isSuccess && !saveMutation.isPending ? (
          <p className="text-sm text-muted-foreground">Saved.</p>
        ) : null}
      </div>
    </div>
  );
}

/* ── Color picker popover ── */

function ColorPicker({
  currentColor,
  onSelect,
}: {
  currentColor: string;
  onSelect: (color: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="shrink-0 h-5 w-5 rounded-md cursor-pointer hover:ring-2 hover:ring-foreground/20 transition-[box-shadow]"
        style={{ backgroundColor: currentColor }}
        aria-label="Change project color"
      />
      {open && (
        <div className="absolute top-full left-0 mt-2 p-2 bg-popover border border-border rounded-lg shadow-lg z-50 w-max">
          <div className="grid grid-cols-5 gap-1.5">
            {PROJECT_COLORS.map((color) => (
              <button
                key={color}
                onClick={() => {
                  onSelect(color);
                  setOpen(false);
                }}
                className={`h-6 w-6 rounded-md cursor-pointer transition-[transform,box-shadow] duration-150 hover:scale-110 ${
                  color === currentColor
                    ? "ring-2 ring-foreground ring-offset-1 ring-offset-background"
                    : "hover:ring-2 hover:ring-foreground/30"
                }`}
                style={{ backgroundColor: color }}
                aria-label={`Select color ${color}`}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── List (issues) tab content ── */

function ProjectIssuesList({ projectId, companyId }: { projectId: string; companyId: string }) {
  const queryClient = useQueryClient();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(companyId),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId),
    enabled: !!companyId,
    refetchInterval: 5000,
  });
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
    enabled: !!companyId,
  });

  const liveIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of liveRuns ?? []) {
      if (run.issueId) ids.add(run.issueId);
    }
    return ids;
  }, [liveRuns]);

  const { data: issues, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.listByProject(companyId, projectId),
    queryFn: () => issuesApi.list(companyId, { projectId }),
    enabled: !!companyId,
  });

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByProject(companyId, projectId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
    },
  });

  return (
    <IssuesList
      issues={issues ?? []}
      isLoading={isLoading}
      error={error as Error | null}
      agents={agents}
      projects={projects}
      liveIssueIds={liveIssueIds}
      projectId={projectId}
      viewStateKey={`paperclip:project-view:${projectId}`}
      onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
    />
  );
}

/* ── Main project page ── */

export function ProjectDetail() {
  const { companyPrefix, projectId, filter } = useParams<{
    companyPrefix?: string;
    projectId: string;
    filter?: string;
  }>();
  const { companies, selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { closePanel } = usePanel();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [fieldSaveStates, setFieldSaveStates] = useState<Partial<Record<ProjectConfigFieldKey, ProjectFieldSaveState>>>({});
  const fieldSaveRequestIds = useRef<Partial<Record<ProjectConfigFieldKey, number>>>({});
  const fieldSaveTimers = useRef<Partial<Record<ProjectConfigFieldKey, ReturnType<typeof setTimeout>>>>({});
  const routeProjectRef = projectId ?? "";
  const routeCompanyId = useMemo(() => {
    if (!companyPrefix) return null;
    const requestedPrefix = companyPrefix.toUpperCase();
    return companies.find((company) => company.issuePrefix.toUpperCase() === requestedPrefix)?.id ?? null;
  }, [companies, companyPrefix]);
  const lookupCompanyId = routeCompanyId ?? selectedCompanyId ?? undefined;
  const canFetchProject = routeProjectRef.length > 0 && (isUuidLike(routeProjectRef) || Boolean(lookupCompanyId));
  const activeRouteTab = routeProjectRef ? resolveProjectTab(location.pathname, routeProjectRef) : null;
  const pluginTabFromSearch = useMemo(() => {
    const tab = new URLSearchParams(location.search).get("tab");
    return isProjectPluginTab(tab) ? tab : null;
  }, [location.search]);
  const activeTab = activeRouteTab ?? pluginTabFromSearch;

  const { data: project, isLoading, error } = useQuery({
    queryKey: [...queryKeys.projects.detail(routeProjectRef), lookupCompanyId ?? null],
    queryFn: () => projectsApi.get(routeProjectRef, lookupCompanyId),
    enabled: canFetchProject,
  });
  const canonicalProjectRef = project ? projectRouteRef(project) : routeProjectRef;
  const projectLookupRef = project?.id ?? routeProjectRef;
  const resolvedCompanyId = project?.companyId ?? selectedCompanyId;
  const experimentalSettingsQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    retry: false,
  });
  const {
    slots: pluginDetailSlots,
    isLoading: pluginDetailSlotsLoading,
  } = usePluginSlots({
    slotTypes: ["detailTab"],
    entityType: "project",
    companyId: resolvedCompanyId,
    enabled: !!resolvedCompanyId,
  });
  const pluginTabItems = useMemo(
    () => pluginDetailSlots.map((slot) => ({
      value: `plugin:${slot.pluginKey}:${slot.id}` as ProjectPluginTab,
      label: slot.displayName,
      slot,
    })),
    [pluginDetailSlots],
  );
  const activePluginTab = pluginTabItems.find((item) => item.value === activeTab) ?? null;
  const isolatedWorkspacesEnabled = experimentalSettingsQuery.data?.enableIsolatedWorkspaces === true;
  const workspaceTabProjectId = project?.id ?? null;
  const { data: workspaceTabIssues = [], isLoading: isWorkspaceTabIssuesLoading, error: workspaceTabIssuesError } = useQuery({
    queryKey: workspaceTabProjectId && resolvedCompanyId
      ? queryKeys.issues.listByProject(resolvedCompanyId, workspaceTabProjectId)
      : ["issues", "__workspace-tab__", "disabled"],
    queryFn: () => issuesApi.list(resolvedCompanyId!, { projectId: workspaceTabProjectId! }),
    enabled: Boolean(resolvedCompanyId && workspaceTabProjectId && isolatedWorkspacesEnabled),
  });
  const {
    data: workspaceTabExecutionWorkspaces = [],
    isLoading: isWorkspaceTabExecutionWorkspacesLoading,
    error: workspaceTabExecutionWorkspacesError,
  } = useQuery({
    queryKey: workspaceTabProjectId && resolvedCompanyId
      ? queryKeys.executionWorkspaces.list(resolvedCompanyId, { projectId: workspaceTabProjectId })
      : ["execution-workspaces", "__workspace-tab__", "disabled"],
    queryFn: () => executionWorkspacesApi.list(resolvedCompanyId!, { projectId: workspaceTabProjectId! }),
    enabled: Boolean(resolvedCompanyId && workspaceTabProjectId && isolatedWorkspacesEnabled),
  });
  const workspaceSummaries = useMemo(() => {
    if (!project || !isolatedWorkspacesEnabled) return [];
    return buildProjectWorkspaceSummaries({
      project,
      issues: workspaceTabIssues,
      executionWorkspaces: workspaceTabExecutionWorkspaces,
    });
  }, [project, isolatedWorkspacesEnabled, workspaceTabIssues, workspaceTabExecutionWorkspaces]);
  const showWorkspacesTab = isolatedWorkspacesEnabled && workspaceSummaries.length > 0;
  const workspaceTabDecisionLoaded =
    experimentalSettingsQuery.isFetched &&
    (!isolatedWorkspacesEnabled || (!isWorkspaceTabIssuesLoading && !isWorkspaceTabExecutionWorkspacesLoading));
  const workspaceTabError = (workspaceTabIssuesError ?? workspaceTabExecutionWorkspacesError) as Error | null;

  useEffect(() => {
    if (!project?.companyId || project.companyId === selectedCompanyId) return;
    setSelectedCompanyId(project.companyId, { source: "route_sync" });
  }, [project?.companyId, selectedCompanyId, setSelectedCompanyId]);

  const invalidateProject = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(routeProjectRef) });
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectLookupRef) });
    if (resolvedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(resolvedCompanyId) });
    }
  };

  const updateProject = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      projectsApi.update(projectLookupRef, data, resolvedCompanyId ?? lookupCompanyId),
    onSuccess: invalidateProject,
  });

  const archiveProject = useMutation({
    mutationFn: (archived: boolean) =>
      projectsApi.update(
        projectLookupRef,
        { archivedAt: archived ? new Date().toISOString() : null },
        resolvedCompanyId ?? lookupCompanyId,
      ),
    onSuccess: (updatedProject, archived) => {
      invalidateProject();
      const name = updatedProject?.name ?? project?.name ?? "Project";
      if (archived) {
        pushToast({ title: `"${name}" has been archived`, tone: "success" });
        navigate("/dashboard");
      } else {
        pushToast({ title: `"${name}" has been unarchived`, tone: "success" });
      }
    },
    onError: (_, archived) => {
      pushToast({
        title: archived ? "Failed to archive project" : "Failed to unarchive project",
        tone: "error",
      });
    },
  });

  const uploadImage = useMutation({
    mutationFn: async (file: File) => {
      if (!resolvedCompanyId) throw new Error("No company selected");
      return assetsApi.uploadImage(resolvedCompanyId, file, `projects/${projectLookupRef || "draft"}`);
    },
  });

  const { data: budgetOverview } = useQuery({
    queryKey: queryKeys.budgets.overview(resolvedCompanyId ?? "__none__"),
    queryFn: () => budgetsApi.overview(resolvedCompanyId!),
    enabled: !!resolvedCompanyId,
    refetchInterval: 30_000,
    staleTime: 5_000,
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Projects", href: "/projects" },
      { label: project?.name ?? routeProjectRef ?? "Project" },
    ]);
  }, [setBreadcrumbs, project, routeProjectRef]);

  useEffect(() => {
    if (!project) return;
    if (routeProjectRef === canonicalProjectRef) return;
    if (isProjectPluginTab(activeTab)) {
      navigate(`/projects/${canonicalProjectRef}?tab=${encodeURIComponent(activeTab)}`, { replace: true });
      return;
    }
    if (activeTab === "overview") {
      navigate(`/projects/${canonicalProjectRef}/overview`, { replace: true });
      return;
    }
    if (activeTab === "context") {
      navigate(`/projects/${canonicalProjectRef}/context`, { replace: true });
      return;
    }
    if (activeTab === "configuration") {
      navigate(`/projects/${canonicalProjectRef}/configuration`, { replace: true });
      return;
    }
    if (activeTab === "budget") {
      navigate(`/projects/${canonicalProjectRef}/budget`, { replace: true });
      return;
    }
    if (activeTab === "workspaces") {
      navigate(`/projects/${canonicalProjectRef}/workspaces`, { replace: true });
      return;
    }
    if (activeTab === "list") {
      if (filter) {
        navigate(`/projects/${canonicalProjectRef}/issues/${filter}`, { replace: true });
        return;
      }
      navigate(`/projects/${canonicalProjectRef}/issues`, { replace: true });
      return;
    }
    navigate(`/projects/${canonicalProjectRef}`, { replace: true });
  }, [project, routeProjectRef, canonicalProjectRef, activeTab, filter, navigate]);

  useEffect(() => {
    closePanel();
    return () => closePanel();
  }, [closePanel]);

  useEffect(() => {
    return () => {
      Object.values(fieldSaveTimers.current).forEach((timer) => {
        if (timer) clearTimeout(timer);
      });
    };
  }, []);

  const setFieldState = useCallback((field: ProjectConfigFieldKey, state: ProjectFieldSaveState) => {
    setFieldSaveStates((current) => ({ ...current, [field]: state }));
  }, []);

  const scheduleFieldReset = useCallback((field: ProjectConfigFieldKey, delayMs: number) => {
    const existing = fieldSaveTimers.current[field];
    if (existing) clearTimeout(existing);
    fieldSaveTimers.current[field] = setTimeout(() => {
      setFieldSaveStates((current) => {
        const next = { ...current };
        delete next[field];
        return next;
      });
      delete fieldSaveTimers.current[field];
    }, delayMs);
  }, []);

  const updateProjectField = useCallback(async (field: ProjectConfigFieldKey, data: Record<string, unknown>) => {
    const requestId = (fieldSaveRequestIds.current[field] ?? 0) + 1;
    fieldSaveRequestIds.current[field] = requestId;
    setFieldState(field, "saving");
    try {
      await projectsApi.update(projectLookupRef, data, resolvedCompanyId ?? lookupCompanyId);
      invalidateProject();
      if (fieldSaveRequestIds.current[field] !== requestId) return;
      setFieldState(field, "saved");
      scheduleFieldReset(field, 1800);
    } catch (error) {
      if (fieldSaveRequestIds.current[field] !== requestId) return;
      setFieldState(field, "error");
      scheduleFieldReset(field, 3000);
      throw error;
    }
  }, [invalidateProject, lookupCompanyId, projectLookupRef, resolvedCompanyId, scheduleFieldReset, setFieldState]);

  const projectBudgetSummary = useMemo(() => {
    const matched = budgetOverview?.policies.find(
      (policy) => policy.scopeType === "project" && policy.scopeId === (project?.id ?? routeProjectRef),
    );
    if (matched) return matched;
    return {
      policyId: "",
      companyId: resolvedCompanyId ?? "",
      scopeType: "project",
      scopeId: project?.id ?? routeProjectRef,
      scopeName: project?.name ?? "Project",
      metric: "billed_cents",
      windowKind: "lifetime",
      amount: 0,
      observedAmount: 0,
      remainingAmount: 0,
      utilizationPercent: 0,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: false,
      status: "ok",
      paused: Boolean(project?.pausedAt),
      pauseReason: project?.pauseReason ?? null,
      windowStart: new Date(),
      windowEnd: new Date(),
    } satisfies BudgetPolicySummary;
  }, [budgetOverview?.policies, project, resolvedCompanyId, routeProjectRef]);

  const budgetMutation = useMutation({
    mutationFn: (amount: number) =>
      budgetsApi.upsertPolicy(resolvedCompanyId!, {
        scopeType: "project",
        scopeId: project?.id ?? routeProjectRef,
        amount,
        windowKind: "lifetime",
      }),
    onSuccess: () => {
      if (!resolvedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.budgets.overview(resolvedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(routeProjectRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectLookupRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(resolvedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(resolvedCompanyId) });
    },
  });

  if (pluginTabFromSearch && !pluginDetailSlotsLoading && !activePluginTab) {
    return <Navigate to={`/projects/${canonicalProjectRef}/issues`} replace />;
  }

  if (activeTab === "workspaces" && workspaceTabDecisionLoaded && !showWorkspacesTab) {
    return <Navigate to={`/projects/${canonicalProjectRef}/issues`} replace />;
  }

  // Redirect bare /projects/:id to cached tab or default /issues
  if (routeProjectRef && activeTab === null) {
    let cachedTab: string | null = null;
    if (project?.id) {
      try { cachedTab = localStorage.getItem(`paperclip:project-tab:${project.id}`); } catch {}
    }
    if (cachedTab === "overview") {
      return <Navigate to={`/projects/${canonicalProjectRef}/overview`} replace />;
    }
    if (cachedTab === "context") {
      return <Navigate to={`/projects/${canonicalProjectRef}/context`} replace />;
    }
    if (cachedTab === "configuration") {
      return <Navigate to={`/projects/${canonicalProjectRef}/configuration`} replace />;
    }
    if (cachedTab === "budget") {
      return <Navigate to={`/projects/${canonicalProjectRef}/budget`} replace />;
    }
    if (cachedTab === "workspaces" && workspaceTabDecisionLoaded && showWorkspacesTab) {
      return <Navigate to={`/projects/${canonicalProjectRef}/workspaces`} replace />;
    }
    if (cachedTab === "workspaces" && !workspaceTabDecisionLoaded) {
      return <PageSkeleton variant="detail" />;
    }
    if (isProjectPluginTab(cachedTab)) {
      return <Navigate to={`/projects/${canonicalProjectRef}?tab=${encodeURIComponent(cachedTab)}`} replace />;
    }
    return <Navigate to={`/projects/${canonicalProjectRef}/issues`} replace />;
  }

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!project) return null;

  const handleTabChange = (tab: ProjectTab) => {
    // Cache the active tab per project
    if (project?.id) {
      try { localStorage.setItem(`paperclip:project-tab:${project.id}`, tab); } catch {}
    }
    if (isProjectPluginTab(tab)) {
      navigate(`/projects/${canonicalProjectRef}?tab=${encodeURIComponent(tab)}`);
      return;
    }
    if (tab === "overview") {
      navigate(`/projects/${canonicalProjectRef}/overview`);
    } else if (tab === "context") {
      navigate(`/projects/${canonicalProjectRef}/context`);
    } else if (tab === "workspaces") {
      navigate(`/projects/${canonicalProjectRef}/workspaces`);
    } else if (tab === "budget") {
      navigate(`/projects/${canonicalProjectRef}/budget`);
    } else if (tab === "configuration") {
      navigate(`/projects/${canonicalProjectRef}/configuration`);
    } else {
      navigate(`/projects/${canonicalProjectRef}/issues`);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <div className="h-7 flex items-center">
          <ColorPicker
            currentColor={project.color ?? "#6366f1"}
            onSelect={(color) => updateProject.mutate({ color })}
          />
        </div>
        <div className="min-w-0 space-y-2">
          <InlineEditor
            value={project.name}
            onSave={(name) => updateProject.mutate({ name })}
            as="h2"
            className="text-xl font-bold"
          />
          {project.pauseReason === "budget" ? (
            <div className="inline-flex items-center gap-2 rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-red-200">
              <span className="h-2 w-2 rounded-full bg-red-400" />
              Paused by budget hard stop
            </div>
          ) : null}
        </div>
      </div>

      <PluginSlotOutlet
        slotTypes={["toolbarButton", "contextMenuItem"]}
        entityType="project"
        context={{
          companyId: resolvedCompanyId ?? null,
          companyPrefix: companyPrefix ?? null,
          projectId: project.id,
          projectRef: canonicalProjectRef,
          entityId: project.id,
          entityType: "project",
        }}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
        missingBehavior="placeholder"
      />

      <PluginLauncherOutlet
        placementZones={["toolbarButton"]}
        entityType="project"
        context={{
          companyId: resolvedCompanyId ?? null,
          companyPrefix: companyPrefix ?? null,
          projectId: project.id,
          projectRef: canonicalProjectRef,
          entityId: project.id,
          entityType: "project",
        }}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
      />

      <Tabs value={activeTab ?? "list"} onValueChange={(value) => handleTabChange(value as ProjectTab)}>
        <PageTabBar
          items={[
            { value: "list", label: "Issues" },
            { value: "overview", label: "Overview" },
            ...(showWorkspacesTab ? [{ value: "workspaces", label: "Workspaces" }] : []),
            { value: "context", label: "Docs" },
            { value: "configuration", label: "Configuration" },
            { value: "budget", label: "Budget" },
            ...pluginTabItems.map((item) => ({
              value: item.value,
              label: item.label,
            })),
          ]}
          align="start"
          value={activeTab ?? "list"}
          onValueChange={(value) => handleTabChange(value as ProjectTab)}
        />
      </Tabs>

      {activeTab === "overview" && (
        <div className="space-y-4">
          <OnboardingReadinessCard
            project={project}
            companyId={resolvedCompanyId!}
            budgetOverview={budgetOverview}
          />
          <OverviewContent
            project={project}
            onUpdate={(data) => updateProject.mutate(data)}
            imageUploadHandler={async (file) => {
              const asset = await uploadImage.mutateAsync(file);
              return asset.contentPath;
            }}
          />
        </div>
      )}

      {activeTab === "list" && project?.id && resolvedCompanyId && (
        <ProjectIssuesList projectId={project.id} companyId={resolvedCompanyId} />
      )}

      {activeTab === "workspaces" ? (
        workspaceTabDecisionLoaded ? (
          workspaceTabError ? (
            <p className="text-sm text-destructive">{workspaceTabError.message}</p>
          ) : (
            <ProjectWorkspacesContent
              companyId={resolvedCompanyId!}
              projectId={project.id}
              projectRef={canonicalProjectRef}
              summaries={workspaceSummaries}
            />
          )
        ) : (
          <p className="text-sm text-muted-foreground">Loading workspaces...</p>
        )
      ) : null}

      {activeTab === "context" && resolvedCompanyId ? (
        <ProjectDocumentsSection projectId={project.id} companyId={resolvedCompanyId} />
      ) : null}

      {activeTab === "configuration" && (
        <div className="max-w-4xl">
          <ProjectProperties
            project={project}
            onUpdate={(data) => updateProject.mutate(data)}
            onFieldUpdate={updateProjectField}
            getFieldSaveState={(field) => fieldSaveStates[field] ?? "idle"}
            onArchive={(archived) => archiveProject.mutate(archived)}
            archivePending={archiveProject.isPending}
          />
        </div>
      )}

      {activeTab === "budget" && resolvedCompanyId ? (
        <div className="max-w-3xl">
          <BudgetPolicyCard
            summary={projectBudgetSummary}
            variant="plain"
            isSaving={budgetMutation.isPending}
            onSave={(amount) => budgetMutation.mutate(amount)}
          />
        </div>
      ) : null}

      {activePluginTab && (
        <PluginSlotMount
          slot={activePluginTab.slot}
          context={{
            companyId: resolvedCompanyId,
            companyPrefix: companyPrefix ?? null,
            projectId: project.id,
            projectRef: canonicalProjectRef,
            entityId: project.id,
            entityType: "project",
          }}
          missingBehavior="placeholder"
        />
      )}
    </div>
  );
}

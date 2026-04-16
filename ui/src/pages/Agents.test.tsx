// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent, CompanyAgentNavigation, OperatingHierarchyAgentSummary } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agents } from "./Agents";

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  navigation: vi.fn(),
  accountability: vi.fn(),
}));

const mockHeartbeatsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockNavigate = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockOpenNewAgent = vi.hoisted(() => vi.fn());
const mockTabsState = vi.hoisted(() => ({
  onValueChange: undefined as ((value: string) => void) | undefined,
}));
const mockLocation = vi.hoisted(() => ({
  pathname: "/agents/all",
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, className, ...props }: ComponentProps<"a"> & { to: string }) => (
    <a href={to} className={className} {...props}>{children}</a>
  ),
  useLocation: () => mockLocation,
  useNavigate: () => mockNavigate,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
  }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    openNewAgent: mockOpenNewAgent,
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockSetBreadcrumbs,
  }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
  }),
}));

vi.mock("../components/PageSkeleton", () => ({
  PageSkeleton: () => <div>Loading…</div>,
}));

vi.mock("../components/EmptyState", () => ({
  EmptyState: ({ message }: { message: string }) => <div>{message}</div>,
}));

vi.mock("../components/StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock("../components/AgentIconPicker", () => ({
  AgentIcon: () => <span aria-hidden="true" />,
}));

vi.mock("../adapters/adapter-display-registry", () => ({
  getAdapterLabel: () => "Process",
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange?: (value: string) => void;
    children: ReactNode;
  }) => {
    mockTabsState.onValueChange = onValueChange;
    return <div>{children}</div>;
  },
  TabsList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ value, children }: { value: string; children: ReactNode }) => (
    <button type="button" onClick={() => mockTabsState.onValueChange?.(value)}>
      {children}
    </button>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Agent",
    urlKey: "agent",
    role: "engineer",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    orgLevel: "staff",
    departmentKey: "engineering",
    departmentName: null,
    capabilities: null,
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    requestedByPrincipalType: null,
    requestedByPrincipalId: null,
    requestedForProjectId: null,
    requestedReason: null,
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-04-16T10:00:00.000Z"),
    updatedAt: new Date("2026-04-16T10:00:00.000Z"),
    ...overrides,
  } as Agent;
}

function createMember(overrides: Partial<OperatingHierarchyAgentSummary> = {}): OperatingHierarchyAgentSummary {
  return {
    id: "member-1",
    name: "Member",
    urlKey: "member",
    role: "engineer",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    orgLevel: "staff",
    operatingClass: "worker",
    capabilityProfileKey: "general",
    archetypeKey: "default",
    departmentKey: "engineering",
    departmentName: null,
    ...overrides,
  } as OperatingHierarchyAgentSummary;
}

function createNavigation(): CompanyAgentNavigation {
  return {
    layout: "department",
    executives: [
      createMember({
        id: "ceo",
        name: "CEO",
        urlKey: "ceo",
        role: "ceo",
        orgLevel: "executive",
        departmentKey: "executive",
      }),
    ],
    departments: [
      {
        key: "engineering",
        name: "Engineering",
        leaders: [
          createMember({
            id: "lead-1",
            name: "Eng Lead",
            urlKey: "eng-lead",
            role: "cto",
            orgLevel: "director",
          }),
        ],
        clusters: [
          {
            clusterId: "cluster-1",
            name: "Hidden Sponsor Cluster",
            slug: "hidden-sponsor-cluster",
            summary: null,
            executiveSponsor: createMember({
              id: "sponsor-1",
              name: "Executive Sponsor",
              urlKey: "executive-sponsor",
              role: "ceo",
              orgLevel: "executive",
              departmentKey: "executive",
            }),
            portfolioDirector: null,
            projects: [],
          },
        ],
        projects: [],
      },
    ],
    portfolioClusters: [],
    projectPods: [],
    sharedServices: [],
    unassigned: [],
  };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("Agents page", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockLocation.pathname = "/agents/all";
    mockAgentsApi.list.mockReset();
    mockAgentsApi.navigation.mockReset();
    mockAgentsApi.accountability.mockReset();
    mockHeartbeatsApi.list.mockReset();

    mockAgentsApi.list.mockResolvedValue([
      createAgent({
        id: "ceo",
        name: "CEO",
        urlKey: "ceo",
        role: "ceo",
        orgLevel: "executive",
        departmentKey: "executive",
      }),
      createAgent({
        id: "lead-1",
        name: "Eng Lead",
        urlKey: "eng-lead",
        role: "cto",
        orgLevel: "director",
      }),
      createAgent({
        id: "sponsor-1",
        name: "Executive Sponsor",
        urlKey: "executive-sponsor",
        role: "ceo",
        orgLevel: "executive",
        departmentKey: "executive",
      }),
    ]);
    mockAgentsApi.navigation.mockResolvedValue(createNavigation());
    mockHeartbeatsApi.list.mockResolvedValue([]);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("uses department navigation only and counts only rendered tree members", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    const root = createRoot(container);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Agents />
        </QueryClientProvider>,
      );
    });

    await flush();
    await flush();

    expect(mockAgentsApi.navigation).toHaveBeenCalledWith("company-1", "department");
    expect(mockAgentsApi.accountability).not.toHaveBeenCalled();

    const buttonLabels = Array.from(container.querySelectorAll("button")).map((button) => button.textContent?.trim() ?? "");
    expect(buttonLabels).not.toContain("Accountability");
    expect(buttonLabels).not.toContain("Department");
    expect(buttonLabels).not.toContain("Project");

    expect(container.textContent).toContain("2 agents in departments");
    expect(container.textContent).toContain("Engineering");
    expect(container.textContent).not.toContain("Executive Sponsor");

    act(() => root.unmount());
  });
});

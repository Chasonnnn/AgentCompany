// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent, CompanyAgentAccountability, OperatingHierarchyAgentSummary } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarAgents } from "./SidebarAgents";

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  navigation: vi.fn(),
  accountability: vi.fn(),
}));

const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
}));

const mockOpenNewAgent = vi.hoisted(() => vi.fn());
const mockSetSidebarOpen = vi.hoisted(() => vi.fn());
const mockLocation = vi.hoisted(() => ({
  pathname: "/agents/ceo",
}));

vi.mock("@/lib/router", () => ({
  NavLink: ({ children, to, className, ...props }: ComponentProps<"a"> & { to: string }) => (
    <a href={to} className={className} {...props}>{children}</a>
  ),
  useLocation: () => mockLocation,
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

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
    setSidebarOpen: mockSetSidebarOpen,
  }),
}));

vi.mock("./AgentIconPicker", () => ({
  AgentIcon: () => <span aria-hidden="true" />,
}));

vi.mock("./BudgetSidebarMarker", () => ({
  BudgetSidebarMarker: () => <span aria-hidden="true" />,
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

function createAccountability(): CompanyAgentAccountability {
  const ceo = createMember({
    id: "ceo",
    name: "CEO",
    urlKey: "ceo",
    role: "ceo",
    orgLevel: "executive",
    departmentKey: "executive",
  });
  const techLead = createMember({
    id: "tech-lead",
    name: "Technical Project Lead",
    urlKey: "technical-project-lead",
    role: "engineer",
    orgLevel: "director",
    operatingClass: "project_leadership",
  });
  const backendOwner = createMember({
    id: "backend-owner",
    name: "Backend/API Continuity Owner",
    urlKey: "backend-api-continuity-owner",
    role: "engineer",
    orgLevel: "staff",
  });

  return {
    companyId: "company-1",
    generatedAt: "2026-04-16T10:00:00.000Z",
    counts: {
      totalConfiguredAgents: 4,
      activeContinuityOwners: 2,
      activeGovernanceLeads: 1,
      activeSharedServiceAgents: 0,
      legacyAgents: 0,
      inactiveAgents: 0,
      simplificationCandidates: 0,
    },
    executiveOffice: [ceo],
    projects: [
      {
        projectId: "project-1",
        projectName: "Onboarding",
        color: null,
        executiveSponsor: ceo,
        portfolioDirector: null,
        leadership: [techLead],
        continuityOwners: [{
          ...backendOwner,
          activeIssueCount: 0,
          blockedContinuityIssueCount: 0,
          openReviewFindingsCount: 0,
          returnedBranchCount: 0,
          issues: [],
        }],
        sharedServices: [],
        issueCounts: {
          active: 1,
          blockedMissingDocs: 0,
          staleProgress: 0,
          invalidHandoff: 0,
          openReviewFindings: 0,
          returnedBranches: 0,
          handoffPending: 0,
        },
      },
    ],
    sharedServices: [],
    unassigned: [],
  };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("SidebarAgents", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockLocation.pathname = "/agents/ceo";
    mockAgentsApi.list.mockReset();
    mockAgentsApi.navigation.mockReset();
    mockAgentsApi.accountability.mockReset();
    mockHeartbeatsApi.liveRunsForCompany.mockReset();

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
        id: "tech-lead",
        name: "Technical Project Lead",
        urlKey: "technical-project-lead",
        role: "engineer",
        orgLevel: "director",
      }),
      createAgent({
        id: "backend-owner",
        name: "Backend/API Continuity Owner",
        urlKey: "backend-api-continuity-owner",
        role: "engineer",
        orgLevel: "staff",
      }),
    ]);
    mockAgentsApi.accountability.mockResolvedValue(createAccountability());
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("uses accountability navigation and renders each project as a direct folder", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    const root = createRoot(container);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarAgents />
        </QueryClientProvider>,
      );
    });

    await flush();
    await flush();

    expect(mockAgentsApi.accountability).toHaveBeenCalledWith("company-1");
    expect(mockAgentsApi.navigation).not.toHaveBeenCalled();

    const onboardingButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Onboarding"));
    expect(onboardingButton?.textContent).toContain("2");
    expect(container.textContent).not.toContain("Departments");
    expect(container.textContent).not.toContain("Projects");
    expect(container.textContent).not.toContain("Technical Project Lead");

    await act(async () => {
      onboardingButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain("Technical Project Lead");
    expect(container.textContent).toContain("Backend/API Continuity Owner");

    act(() => root.unmount());
  });
});

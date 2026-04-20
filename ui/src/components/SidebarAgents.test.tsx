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
    name: "Project Lead",
    urlKey: "project-lead",
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
        projectLead: techLead,
        leadership: [techLead],
        continuityOwners: [{
          ...backendOwner,
          activeIssueCount: 0,
          blockedContinuityIssueCount: 0,
          openReviewFindingsCount: 0,
          returnedBranchCount: 0,
          issues: [],
        }],
        executiveIssueOwners: [],
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
        name: "Project Lead",
        urlKey: "project-lead",
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
    expect(container.textContent).not.toContain("Project Lead");

    await act(async () => {
      onboardingButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain("Project Lead");
    expect(container.textContent).toContain("Backend/API Continuity Owner");
    expect(container.textContent).toContain("Sponsor: CEO");
    expect(container.querySelectorAll('a[href="/agents/ceo"]').length).toBe(1);

    act(() => root.unmount());
  });

  it("shows consultant specialists under shared services and renames the orphan bucket", async () => {
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
        id: "research-specialist",
        name: "Research Specialist",
        urlKey: "research-specialist",
        role: "researcher",
        departmentKey: "research",
      }),
      createAgent({
        id: "growth-specialist",
        name: "Growth Specialist",
        urlKey: "growth-specialist",
        role: "general",
        departmentKey: "marketing",
      }),
      createAgent({
        id: "consulting-specialist",
        name: "Consulting Specialist",
        urlKey: "consulting-specialist",
        role: "general",
        departmentKey: "general",
      }),
      createAgent({
        id: "enablement-lead",
        name: "Enablement Lead",
        urlKey: "enablement-lead",
        role: "general",
        orgLevel: "director",
        departmentKey: "custom",
        departmentName: "Enablement",
      }),
      createAgent({
        id: "ops-floater",
        name: "Ops Floater",
        urlKey: "ops-floater",
        role: "general",
        departmentKey: "operations",
      }),
    ]);
    mockAgentsApi.accountability.mockResolvedValue({
      ...createAccountability(),
      counts: {
        totalConfiguredAgents: 5,
        activeContinuityOwners: 1,
        activeGovernanceLeads: 1,
        activeSharedServiceAgents: 3,
        legacyAgents: 0,
        inactiveAgents: 0,
        simplificationCandidates: 0,
      },
      projects: [
        {
          ...createAccountability().projects[0]!,
          sharedServices: [
            createMember({
              id: "growth-specialist",
              name: "Growth Specialist",
              urlKey: "growth-specialist",
              role: "general",
              operatingClass: "consultant",
              departmentKey: "marketing",
            }),
          ],
        },
      ],
      sharedServices: [
        {
          key: "custom",
          name: "Enablement",
          leaders: [
            createMember({
              id: "enablement-lead",
              name: "Enablement Lead",
              urlKey: "enablement-lead",
              role: "general",
              orgLevel: "director",
              operatingClass: "shared_service_lead",
              departmentKey: "custom",
              departmentName: "Enablement",
            }),
          ],
          projects: [],
        },
        {
          key: "research",
          name: "Research",
          leaders: [
            createMember({
              id: "research-specialist",
              name: "Research Specialist",
              urlKey: "research-specialist",
              role: "researcher",
              operatingClass: "consultant",
              departmentKey: "research",
            }),
          ],
          projects: [],
        },
      ],
      unassigned: [
        createMember({
          id: "ops-floater",
          name: "Ops Floater",
          urlKey: "ops-floater",
          role: "general",
          departmentKey: "operations",
        }),
      ],
    });

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

    expect(container.textContent).toContain("Consulting Team");
    expect(container.textContent).toContain("Shared Services");
    expect(container.textContent).toContain("Needs Scope");
    expect(container.textContent).not.toContain("Unassigned");
    expect(container.textContent).not.toContain("Shared Specialists");

    const consultingTeamButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Consulting Team"));
    expect(consultingTeamButton).toBeTruthy();
    expect(consultingTeamButton?.textContent).toContain("2");

    await act(async () => {
      consultingTeamButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain("Research Specialist");
    expect(container.textContent).toContain("Researcher · Research");
    expect(container.textContent).toContain("Growth Specialist");
    expect(container.textContent).toContain("General · Marketing");
    expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Research")).toBe(false);
    expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Marketing")).toBe(false);

    const sharedServicesButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Shared Services"));
    expect(sharedServicesButton).toBeTruthy();

    await act(async () => {
      sharedServicesButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const enablementButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Enablement"));
    expect(enablementButton).toBeTruthy();

    await act(async () => {
      enablementButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain("Enablement Lead");

    const needsScopeButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Needs Scope"));
    expect(needsScopeButton).toBeTruthy();

    await act(async () => {
      needsScopeButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain("Ops Floater");

    act(() => root.unmount());
  });

  it("renders executive continuity ownership as neutral metadata instead of a warning", async () => {
    mockAgentsApi.accountability.mockResolvedValue({
      ...createAccountability(),
      projects: [
        {
          ...createAccountability().projects[0]!,
          executiveIssueOwners: [
            {
              ...createMember({
                id: "ceo",
                name: "CEO",
                urlKey: "ceo",
                role: "ceo",
                orgLevel: "executive",
                operatingClass: "executive",
                departmentKey: "executive",
              }),
              activeIssueCount: 2,
              blockedContinuityIssueCount: 0,
              openReviewFindingsCount: 0,
              returnedBranchCount: 0,
              issues: [],
            },
          ],
          issueCounts: {
            active: 2,
            blockedMissingDocs: 0,
            staleProgress: 0,
            invalidHandoff: 0,
            openReviewFindings: 0,
            returnedBranches: 0,
            handoffPending: 0,
          },
        },
      ],
    });

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

    const onboardingButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Onboarding"));
    expect(onboardingButton?.textContent).toContain("3");

    expect(container.textContent).toContain("Executive continuity owners");
    expect(container.textContent).toContain("CEO · 2 active issues");
    expect(container.textContent).not.toContain("Executive-owned execution issue");
    expect(container.textContent).not.toContain("Hand off to Project Lead");

    act(() => root.unmount());
  });
});

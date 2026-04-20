// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CompanyAgentAccountability, OperatingHierarchyAgentSummary } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Org } from "./Org";

const mockAgentsApi = vi.hoisted(() => ({
  accountability: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, className, ...props }: ComponentProps<"a"> & { to: string }) => (
    <a href={to} className={className} {...props}>{children}</a>
  ),
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockSetBreadcrumbs,
  }),
}));

vi.mock("../components/EmptyState", () => ({
  EmptyState: ({ message }: { message: string }) => <div>{message}</div>,
}));

vi.mock("../components/PageSkeleton", () => ({
  PageSkeleton: () => <div>Loading…</div>,
}));

vi.mock("../components/StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

  return {
    companyId: "company-1",
    generatedAt: "2026-04-19T12:00:00.000Z",
    counts: {
      totalConfiguredAgents: 5,
      activeContinuityOwners: 0,
      activeGovernanceLeads: 1,
      activeSharedServiceAgents: 3,
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
        projectLead: null,
        leadership: [],
        continuityOwners: [],
        executiveIssueOwners: [],
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
  };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("Org page", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAgentsApi.accountability.mockReset();
    mockAgentsApi.accountability.mockResolvedValue(createAccountability());
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders a flat consulting team separately from shared-service leads", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    const root = createRoot(container);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Org />
        </QueryClientProvider>,
      );
    });

    await flush();
    await flush();

    expect(mockAgentsApi.accountability).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("Consulting Team");
    expect(container.textContent).toContain("Research Specialist");
    expect(container.textContent).toContain("Growth Specialist");
    expect(container.textContent).toContain("Researcher · Research");
    expect(container.textContent).toContain("General · Marketing");
    expect(container.textContent).toContain("Enablement Lead");
    expect(container.textContent).toContain("Needs Scope");
    expect(container.textContent).toContain("Ops Floater");
    expect(container.textContent).not.toContain("Unassigned");
    expect(container.textContent).not.toContain("Shared Specialists");

    act(() => root.unmount());
  });

  it("shows executive continuity owners as a neutral project member section", async () => {
    const executiveOwner = {
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
    };
    mockAgentsApi.accountability.mockResolvedValue({
      ...createAccountability(),
      projects: [
        {
          ...createAccountability().projects[0]!,
          executiveIssueOwners: [executiveOwner],
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
          <Org />
        </QueryClientProvider>,
      );
    });

    await flush();
    await flush();

    expect(container.textContent).toContain("Executive Continuity Owners");
    expect(container.textContent).toContain("CEO");
    expect(container.textContent).toContain("CEO · 2 active issues");
    expect(container.textContent).not.toContain("Executive-owned execution issues");
    expect(container.textContent).not.toContain("Hand off to Project Lead");

    act(() => root.unmount());
  });
});

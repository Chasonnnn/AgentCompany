// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent, CompanyAgentNavigation, OperatingHierarchyAgentSummary } from "@paperclipai/shared";
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

function createNavigation(): CompanyAgentNavigation {
  const ceo = createMember({
    id: "ceo",
    name: "CEO",
    urlKey: "ceo",
    role: "ceo",
    orgLevel: "executive",
    departmentKey: "executive",
  });
  const engineer = createMember({
    id: "engineer-1",
    name: "Engineer",
    urlKey: "engineer",
    role: "engineer",
    departmentKey: "engineering",
  });

  return {
    layout: "department",
    executives: [ceo],
    departments: [
      {
        key: "engineering",
        name: "Engineering",
        leaders: [engineer],
        clusters: [],
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
        id: "engineer-1",
        name: "Engineer",
        urlKey: "engineer",
        role: "engineer",
      }),
    ]);
    mockAgentsApi.navigation.mockResolvedValue(createNavigation());
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("uses department navigation only and allows expanding departments while executives is auto-open", async () => {
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

    expect(mockAgentsApi.navigation).toHaveBeenCalledWith("company-1", "department");
    expect(mockAgentsApi.accountability).not.toHaveBeenCalled();

    const buttonLabels = Array.from(container.querySelectorAll("button")).map((button) => button.textContent?.trim() ?? "");
    expect(buttonLabels).not.toContain("Accountability");
    expect(buttonLabels).not.toContain("Project");

    const departmentsButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Departments"));
    expect(departmentsButton?.textContent).toContain("1");
    expect(container.textContent).not.toContain("Engineer");

    await act(async () => {
      departmentsButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const engineeringButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Engineering"));
    expect(engineeringButton).not.toBeUndefined();

    await act(async () => {
      engineeringButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain("Engineer");

    act(() => root.unmount());
  });
});

// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CompanyAgentHierarchy, ConferenceRoom as ConferenceRoomType, Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConferenceRoom } from "./ConferenceRoom";

const mockConferenceRoomsApi = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  hierarchy: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());
const mockUseLocation = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, className, ...props }: ComponentProps<"a"> & { to: string }) => (
    <a href={to} className={className} {...props}>{children}</a>
  ),
  useLocation: () => mockUseLocation(),
  useNavigate: () => mockNavigate,
}));

vi.mock("../api/conferenceRooms", () => ({
  conferenceRoomsApi: mockConferenceRoomsApi,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
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

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({
    pushToast: vi.fn(),
  }),
}));

vi.mock("../components/PageSkeleton", () => ({
  PageSkeleton: () => <div>Loading…</div>,
}));

vi.mock("../components/PageTabBar", () => ({
  PageTabBar: ({ items }: { items: Array<{ value: string; label: ReactNode }> }) => (
    <div>{items.map((item) => <span key={item.value}>{item.value}</span>)}</div>
  ),
}));

vi.mock("../components/ConferenceRoomEditorDialog", () => ({
  ConferenceRoomEditorDialog: ({ open }: { open: boolean }) => (open ? <div>Room editor</div> : null),
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createHierarchy(): CompanyAgentHierarchy {
  return {
    executives: [],
    unassigned: {
      executives: [],
      directors: [],
      staff: [],
    },
  };
}

function createIssue(id: string, identifier: string, title: string): Issue {
  const now = new Date("2026-04-09T12:00:00.000Z");
  return {
    id,
    identifier,
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title,
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    originKind: "manual",
    originId: null,
    originRunId: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionPolicy: null,
    executionState: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: now,
    updatedAt: now,
    labels: [],
    labelIds: [],
    lastActivityAt: now,
  };
}

function createRoom(id: string, status: ConferenceRoomType["status"], title: string): ConferenceRoomType {
  const now = new Date("2026-04-09T12:00:00.000Z");
  return {
    id,
    companyId: "company-1",
    title,
    summary: `${title} summary`,
    agenda: null,
    status,
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdAt: now,
    updatedAt: now,
    linkedIssues: [{
      issueId: "issue-1",
      identifier: "AIWA-1",
      title: "Hire your first engineer and create a hiring plan",
      status: "todo",
      priority: "medium",
      createdAt: now,
    }],
    participants: [],
    decisions: [],
    latestCommentAt: null,
  };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("ConferenceRoom", () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    mockSetBreadcrumbs.mockReset();
    mockNavigate.mockReset();
    mockUseLocation.mockReset();
    mockConferenceRoomsApi.list.mockReset();
    mockConferenceRoomsApi.create.mockReset();
    mockAgentsApi.hierarchy.mockReset();
    mockIssuesApi.list.mockReset();
    mockUseLocation.mockReturnValue({ pathname: "/conference-room/open", search: "", hash: "" });
    mockAgentsApi.hierarchy.mockResolvedValue(createHierarchy());
    mockIssuesApi.list.mockResolvedValue([
      createIssue("issue-1", "AIWA-1", "Hire your first engineer and create a hiring plan"),
    ]);
  });

  afterEach(() => {
    queryClient.clear();
    container.remove();
  });

  it("filters the default view to open rooms", async () => {
    mockConferenceRoomsApi.list.mockResolvedValue([
      createRoom("room-open", "open", "Hiring leadership sync"),
      createRoom("room-closed", "closed", "Closed room"),
    ]);

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ConferenceRoom />
        </QueryClientProvider>,
      );
    });

    await flush();

    expect(mockSetBreadcrumbs).toHaveBeenCalledWith([{ label: "Conference Room" }]);
    expect(container.textContent).toContain("Hiring leadership sync");
    expect(container.textContent).not.toContain("Closed room");
    expect(container.querySelector('a[href="/conference-room/rooms/room-open"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("shows all rooms on the all route", async () => {
    mockUseLocation.mockReturnValue({ pathname: "/conference-room/all", search: "", hash: "" });
    mockConferenceRoomsApi.list.mockResolvedValue([
      createRoom("room-open", "open", "Hiring leadership sync"),
      createRoom("room-closed", "closed", "Closed room"),
    ]);

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ConferenceRoom />
        </QueryClientProvider>,
      );
    });

    await flush();

    expect(container.textContent).toContain("Hiring leadership sync");
    expect(container.textContent).toContain("Closed room");

    await act(async () => {
      root.unmount();
    });
  });
});

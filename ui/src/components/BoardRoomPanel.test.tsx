// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CompanyAgentHierarchy, ConferenceRoom, Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardRoomPanel } from "./BoardRoomPanel";

const mockConferenceRoomsApi = vi.hoisted(() => ({
  listForIssue: vi.fn(),
  createForIssue: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  operatingHierarchy: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, className, ...props }: ComponentProps<"a"> & { to: string }) => (
    <a href={to} className={className} {...props}>{children}</a>
  ),
}));

vi.mock("@/api/conferenceRooms", () => ({
  conferenceRoomsApi: mockConferenceRoomsApi,
}));

vi.mock("@/api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("@/api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("./ConferenceRoomEditorDialog", () => ({
  ConferenceRoomEditorDialog: ({
    open,
    onOpenChange,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => (
    open ? (
      <div>
        <div>Composer Open</div>
        <button type="button" onClick={() => onOpenChange(false)}>Close composer</button>
      </div>
    ) : null
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createIssue(): Issue {
  const now = new Date("2026-04-09T12:00:00.000Z");
  return {
    id: "issue-1",
    identifier: "AIWA-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Hire your first engineer and create a hiring plan",
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

function createRoom(id: string, title: string): ConferenceRoom {
  const now = new Date("2026-04-09T12:00:00.000Z");
  return {
    id,
    companyId: "company-1",
    title,
    summary: "Leadership coordination room",
    agenda: null,
    kind: "project_leadership",
    status: "open",
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

describe("BoardRoomPanel", () => {
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
    mockConferenceRoomsApi.listForIssue.mockReset();
    mockConferenceRoomsApi.createForIssue.mockReset();
    mockAgentsApi.operatingHierarchy.mockReset();
    mockIssuesApi.list.mockReset();
    mockConferenceRoomsApi.createForIssue.mockResolvedValue(createRoom("room-created", "New room"));
    mockAgentsApi.operatingHierarchy.mockResolvedValue(createHierarchy());
    mockIssuesApi.list.mockResolvedValue([]);
  });

  afterEach(() => {
    queryClient.clear();
    container.remove();
  });

  it("renders rooms linked to the current issue", async () => {
    mockConferenceRoomsApi.listForIssue.mockResolvedValue([
      createRoom("room-1", "Hiring leadership sync"),
    ]);

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <BoardRoomPanel issue={createIssue()} composerOpen={false} onComposerOpenChange={() => {}} />
        </QueryClientProvider>,
      );
    });

    await flush();

    expect(container.textContent).toContain("Hiring leadership sync");
    expect(container.textContent).toContain("Leadership coordination room");
    expect(container.querySelector('a[href="/conference-room/rooms/room-1"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("shows the empty state and opens the composer", async () => {
    mockConferenceRoomsApi.listForIssue.mockResolvedValue([]);
    const onComposerOpenChange = vi.fn();

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <BoardRoomPanel issue={createIssue()} composerOpen={false} onComposerOpenChange={onComposerOpenChange} />
        </QueryClientProvider>,
      );
    });

    await flush();

    expect(container.textContent).toContain("No conference rooms linked to this issue yet.");
    const button = Array.from(container.querySelectorAll("button")).find((node) => node.textContent?.includes("Open conference room"));
    expect(button).not.toBeUndefined();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onComposerOpenChange).toHaveBeenCalledWith(true);

    await act(async () => {
      root.unmount();
    });
  });
});

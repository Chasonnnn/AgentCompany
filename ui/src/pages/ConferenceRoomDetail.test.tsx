// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  Agent,
  CompanyOperatingHierarchy,
  ConferenceRoom as ConferenceRoomType,
  ConferenceRoomComment,
  Issue,
} from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConferenceRoomDetail } from "./ConferenceRoomDetail";

const mockConferenceRoomsApi = vi.hoisted(() => ({
  get: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
  update: vi.fn(),
  requestBoardDecision: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  operatingHierarchy: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, className, ...props }: ComponentProps<"a"> & { to: string }) => (
    <a href={to} className={className} {...props}>{children}</a>
  ),
  useNavigate: () => mockNavigate,
  useParams: () => ({ roomId: "room-1" }),
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
  PageSkeleton: () => <div>Loading...</div>,
}));

vi.mock("../components/ConferenceRoomEditorDialog", () => ({
  ConferenceRoomEditorDialog: () => null,
}));

vi.mock("../components/PacketMarkdownBody", () => ({
  PacketMarkdownBody: ({ markdown }: { markdown: string }) => <div>{markdown}</div>,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createHierarchy(): CompanyOperatingHierarchy {
  return {
    executiveOffice: [],
    projectPods: [],
    sharedServices: [],
    unassigned: [],
  };
}

function createRoom(): ConferenceRoomType {
  const now = new Date("2026-04-17T00:48:07.000Z");
  return {
    id: "room-1",
    companyId: "company-1",
    title: "Onboarding Meeting",
    summary: "Kickoff room",
    agenda: "checklist",
    kind: "project_leadership",
    status: "open",
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdAt: now,
    updatedAt: now,
    linkedIssues: [],
    participants: [
      {
        id: "participant-1",
        companyId: "company-1",
        conferenceRoomId: "room-1",
        agentId: "agent-1",
        addedByAgentId: null,
        addedByUserId: "user-1",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "participant-2",
        companyId: "company-1",
        conferenceRoomId: "room-1",
        agentId: "agent-2",
        addedByAgentId: null,
        addedByUserId: "user-1",
        createdAt: now,
        updatedAt: now,
      },
    ],
    decisions: [],
    latestCommentAt: now,
  };
}

function createComments(): ConferenceRoomComment[] {
  const baseTime = new Date("2026-04-17T00:48:07.000Z");
  return [
    {
      id: "comment-question",
      companyId: "company-1",
      conferenceRoomId: "room-1",
      parentCommentId: null,
      authorAgentId: null,
      authorUserId: "user-1",
      body: "How do you feel about the audit?",
      messageType: "question",
      createdAt: baseTime,
      updatedAt: baseTime,
      responses: [
        {
          id: "response-1",
          companyId: "company-1",
          conferenceRoomId: "room-1",
          questionCommentId: "comment-question",
          agentId: "agent-1",
          status: "pending",
          repliedCommentId: null,
          latestWakeStatus: "failed",
          latestWakeError: "Your access token could not be refreshed. Please log out and sign in again.",
          latestWakeRequestedAt: baseTime,
          createdAt: baseTime,
          updatedAt: baseTime,
        },
        {
          id: "response-2",
          companyId: "company-1",
          conferenceRoomId: "room-1",
          questionCommentId: "comment-question",
          agentId: "agent-2",
          status: "replied",
          repliedCommentId: "comment-reply",
          latestWakeStatus: null,
          latestWakeError: null,
          latestWakeRequestedAt: null,
          createdAt: baseTime,
          updatedAt: new Date(baseTime.getTime() + 30_000),
        },
      ],
    },
    {
      id: "comment-reply",
      companyId: "company-1",
      conferenceRoomId: "room-1",
      parentCommentId: "comment-question",
      authorAgentId: "agent-2",
      authorUserId: null,
      body: "The audit looks good from engineering.",
      messageType: "note",
      createdAt: new Date(baseTime.getTime() + 60_000),
      updatedAt: new Date(baseTime.getTime() + 60_000),
      responses: [],
    },
  ];
}

function createAgents(): Agent[] {
  return [
    { id: "agent-1", companyId: "company-1", name: "Technical Project Lead" } as Agent,
    { id: "agent-2", companyId: "company-1", name: "CEO" } as Agent,
  ];
}

function createIssues(): Issue[] {
  return [
    { id: "issue-1", identifier: "PAP-1", title: "Kickoff onboarding work" } as Issue,
  ];
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function setNativeTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  const previous = textarea.value;
  valueSetter?.call(textarea, value);
  const tracker = (textarea as HTMLTextAreaElement & { _valueTracker?: { setValue: (value: string) => void } })._valueTracker;
  tracker?.setValue(previous);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function findButton(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll("button")).find((node) => node.textContent?.includes(label)) ?? null;
}

describe("ConferenceRoomDetail", () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.useRealTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    mockConferenceRoomsApi.get.mockReset();
    mockConferenceRoomsApi.listComments.mockReset();
    mockConferenceRoomsApi.addComment.mockReset();
    mockConferenceRoomsApi.update.mockReset();
    mockConferenceRoomsApi.requestBoardDecision.mockReset();
    mockAgentsApi.list.mockReset();
    mockAgentsApi.operatingHierarchy.mockReset();
    mockIssuesApi.list.mockReset();
    mockSetBreadcrumbs.mockReset();
    mockNavigate.mockReset();

    mockConferenceRoomsApi.get.mockResolvedValue(createRoom());
    mockConferenceRoomsApi.listComments.mockResolvedValue(createComments());
    mockConferenceRoomsApi.addComment.mockImplementation(async (_roomId: string, data: unknown) => ({
      id: "created-comment",
      companyId: "company-1",
      conferenceRoomId: "room-1",
      parentCommentId: null,
      authorAgentId: null,
      authorUserId: "user-1",
      body: typeof data === "object" && data && "body" in (data as Record<string, unknown>)
        ? String((data as Record<string, unknown>).body)
        : "",
      messageType: "note",
      createdAt: new Date("2026-04-17T00:50:00.000Z"),
      updatedAt: new Date("2026-04-17T00:50:00.000Z"),
      responses: [],
    }));
    mockAgentsApi.list.mockResolvedValue(createAgents());
    mockAgentsApi.operatingHierarchy.mockResolvedValue(createHierarchy());
    mockIssuesApi.list.mockResolvedValue(createIssues());
  });

  afterEach(() => {
    vi.useRealTimers();
    queryClient.clear();
    container.remove();
  });

  it("renders threaded questions with response state and refetches while the room is open", async () => {
    const currentRoom = createRoom();
    let currentComments = createComments().slice(0, 1);

    mockConferenceRoomsApi.get.mockImplementation(async () => currentRoom);
    mockConferenceRoomsApi.listComments.mockImplementation(async () => currentComments);

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ConferenceRoomDetail />
        </QueryClientProvider>,
      );
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Onboarding Meeting");
      expect(container.textContent).toContain("1 pending");
      expect(container.textContent).toContain("1 replied");
      expect(container.textContent).toContain("1 wake failure");
      expect(container.textContent).toContain("Your access token could not be refreshed. Please log out and sign in again.");
      expect(container.textContent).not.toContain("The audit looks good from engineering.");
    });

    currentComments = createComments();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3_200));
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("The audit looks good from engineering.");
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("posts top-level questions with question metadata", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ConferenceRoomDetail />
        </QueryClientProvider>,
      );
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("New room message");
    });

    const textarea = container.querySelector("textarea");
    const questionButton = findButton(container, "Question");

    expect(textarea).not.toBeNull();
    expect(questionButton).not.toBeNull();

    await act(async () => {
      questionButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitForAssertion(() => {
      expect(findButton(container, "Post question")).not.toBeNull();
    });
    await act(async () => {
      setNativeTextareaValue(textarea!, "Please each reply with your audit view.");
    });
    await act(async () => {
      findButton(container, "Post question")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(mockConferenceRoomsApi.addComment).toHaveBeenCalledWith("room-1", {
        body: "Please each reply with your audit view.",
        messageType: "question",
      });
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("posts replies under the selected parent thread", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ConferenceRoomDetail />
        </QueryClientProvider>,
      );
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Reply");
    });

    await act(async () => {
      findButton(container, "Reply")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Replying to Board (question)");
      expect(container.textContent).toContain("Post reply");
    });

    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();

    await act(async () => {
      setNativeTextareaValue(textarea!, "I think the audit direction is solid.");
    });
    await flush();
    await act(async () => {
      findButton(container, "Post reply")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(mockConferenceRoomsApi.addComment).toHaveBeenCalledWith("room-1", {
        body: "I think the audit direction is solid.",
        messageType: "note",
        parentCommentId: "comment-question",
      });
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps the discussion panel bounded with an internal desktop scroll region", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ConferenceRoomDetail />
        </QueryClientProvider>,
      );
    });

    await waitForAssertion(() => {
      const discussionPanel = container.querySelector('[data-testid="conference-room-discussion"]');
      const scrollRegion = container.querySelector('[data-testid="conference-room-discussion-scroll"]');

      expect(discussionPanel).not.toBeNull();
      expect(scrollRegion).not.toBeNull();
      expect(String(discussionPanel?.getAttribute("class"))).toContain("lg:max-h-[calc(100vh-2rem)]");
      expect(String(discussionPanel?.getAttribute("class"))).toContain("lg:overflow-hidden");
      expect(String(scrollRegion?.getAttribute("class"))).toContain("lg:flex-1");
      expect(String(scrollRegion?.getAttribute("class"))).toContain("lg:overflow-y-auto");
    });

    await act(async () => {
      root.unmount();
    });
  });
});

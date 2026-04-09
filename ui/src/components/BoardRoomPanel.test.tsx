// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { Agent, Approval, ApprovalComment, ConferenceContext } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardRoomPanel } from "./BoardRoomPanel";

const mockApprovalsApi = vi.hoisted(() => ({
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  getConferenceContext: vi.fn(),
}));

vi.mock("@/api/approvals", () => ({
  approvalsApi: mockApprovalsApi,
}));

vi.mock("@/api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("./ApprovalCard", () => ({
  ApprovalCard: ({ approval }: { approval: Approval }) => (
    <div data-testid={`approval-${approval.id}`}>{String(approval.payload.title ?? approval.id)}</div>
  ),
}));

vi.mock("./EmptyState", () => ({
  EmptyState: ({
    message,
    action,
    onAction,
  }: {
    message: string;
    action?: string;
    onAction?: () => void;
  }) => (
    <div>
      <div>{message}</div>
      {action && onAction ? <button type="button" onClick={onAction}>{action}</button> : null}
    </div>
  ),
}));

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, type = "button", ...props }: ComponentProps<"button">) => (
    <button type={type} onClick={onClick} {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: ComponentProps<"input">) => <input {...props} />,
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function setNativeTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  const previous = textarea.value;
  valueSetter?.call(textarea, value);
  const tracker = (textarea as HTMLTextAreaElement & { _valueTracker?: { setValue: (v: string) => void } })
    ._valueTracker;
  tracker?.setValue(previous);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function createComment(id: string, body: string): ApprovalComment {
  return {
    id,
    companyId: "company-1",
    approvalId: "approval-board",
    authorAgentId: "agent-1",
    authorUserId: null,
    body,
    createdAt: new Date("2026-04-07T01:00:00.000Z"),
    updatedAt: new Date("2026-04-07T01:00:00.000Z"),
  };
}

function createAgent(): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Director",
    urlKey: "director",
    role: "pm",
    title: null,
    icon: "hexagon",
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-04-07T00:00:00.000Z"),
    updatedAt: new Date("2026-04-07T00:00:00.000Z"),
  };
}

function createApproval(id: string, type: Approval["type"], title: string): Approval {
  return {
    id,
    companyId: "company-1",
    type,
    requestedByAgentId: "agent-1",
    requestedByUserId: null,
    status: "pending",
    payload: { title },
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-04-07T00:00:00.000Z"),
    updatedAt: new Date("2026-04-07T00:00:00.000Z"),
  };
}

function createConferenceContext(): ConferenceContext {
  return {
    capturedAt: "2026-04-08T12:00:00.000Z",
    projectWorkspace: {
      id: "11111111-1111-4111-8111-111111111111",
      projectId: "22222222-2222-4222-8222-222222222222",
      name: "Primary Repo",
      sourceType: "local_path",
      isPrimary: true,
      repoUrl: "https://github.com/acme/paperclip",
      repoRef: "main",
      defaultRef: "main",
    },
    executionWorkspace: {
      id: "33333333-3333-4333-8333-333333333333",
      projectId: "22222222-2222-4222-8222-222222222222",
      projectWorkspaceId: "11111111-1111-4111-8111-111111111111",
      name: "Issue Worktree",
      mode: "isolated_workspace",
      status: "active",
      providerType: "git_worktree",
      repoUrl: "https://github.com/acme/paperclip",
      baseRef: "origin/main",
      branchName: "codex/conference-context",
    },
    git: {
      rootPath: "/Users/chason/paperclip",
      workspacePath: "/Users/chason/paperclip/worktrees/issue-1",
      displayRootPath: "paperclip",
      displayWorkspacePath: "paperclip/worktrees/issue-1",
      branchName: "codex/conference-context",
      baseRef: "origin/main",
      isGit: true,
      dirty: true,
      dirtyEntryCount: 2,
      untrackedEntryCount: 1,
      aheadCount: 3,
      behindCount: 0,
      changedFileCount: 2,
      truncated: false,
      changedFiles: [
        {
          path: "server/src/routes/issues.ts",
          previousPath: null,
          indexStatus: "M",
          worktreeStatus: " ",
          status: "M ",
        },
        {
          path: "ui/src/components/BoardRoomPanel.tsx",
          previousPath: null,
          indexStatus: " ",
          worktreeStatus: "M",
          status: " M",
        },
      ],
    },
  };
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
    mockApprovalsApi.listComments.mockReset();
    mockApprovalsApi.addComment.mockReset();
    mockIssuesApi.getConferenceContext.mockReset();
  });

  afterEach(() => {
    container.remove();
    queryClient.clear();
  });

  it("renders only board-room approvals", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <BoardRoomPanel
              approvals={[
                createApproval("approval-board", "request_board_approval", "Approve issue strategy"),
                createApproval("approval-budget", "budget_override_required", "Budget exception"),
              ]}
              agentMap={new Map([["agent-1", createAgent()]])}
              onRequestBoardDecision={async () => {}}
              onApproveApproval={async () => {}}
              onRejectApproval={async () => {}}
              pendingApprovalAction={null}
            />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    expect(container.textContent).toContain("Approve issue strategy");
    expect(container.textContent).not.toContain("Budget exception");

    act(() => {
      root.unmount();
    });
  });

  it("submits a normalized board-room request payload", async () => {
    const root = createRoot(container);
    const onRequestBoardDecision = vi.fn().mockResolvedValue(undefined);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <BoardRoomPanel
              approvals={[]}
              agentMap={new Map([["agent-1", createAgent()]])}
              onRequestBoardDecision={onRequestBoardDecision}
              onApproveApproval={async () => {}}
              onRejectApproval={async () => {}}
              pendingApprovalAction={null}
            />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    const openButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Request board decision"),
    );
    expect(openButton).not.toBeUndefined();

    await act(async () => {
      openButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const titleInput = container.querySelector('input[name="title"]') as HTMLInputElement | null;
    const summaryInput = container.querySelector('textarea[name="summary"]') as HTMLTextAreaElement | null;
    const recommendedActionInput = container.querySelector('textarea[name="recommendedAction"]') as HTMLTextAreaElement | null;
    const nextActionInput = container.querySelector('textarea[name="nextActionOnApproval"]') as HTMLTextAreaElement | null;
    const risksInput = container.querySelector('textarea[name="risks"]') as HTMLTextAreaElement | null;
    const proposedCommentInput = container.querySelector('textarea[name="proposedComment"]') as HTMLTextAreaElement | null;

    await act(async () => {
      titleInput!.value = "  Approve board room rollout ";
      titleInput!.dispatchEvent(new Event("change", { bubbles: true }));
      summaryInput!.value = "  Pilot this on issue detail first. ";
      summaryInput!.dispatchEvent(new Event("change", { bubbles: true }));
      const roomTitleInput = container.querySelector('input[name="roomTitle"]') as HTMLInputElement | null;
      roomTitleInput!.value = "  Migration Readiness Council ";
      roomTitleInput!.dispatchEvent(new Event("change", { bubbles: true }));
      const agendaInput = container.querySelector('textarea[name="agenda"]') as HTMLTextAreaElement | null;
      agendaInput!.value = "  Review blockers, risks, and the staged rollout plan. ";
      agendaInput!.dispatchEvent(new Event("change", { bubbles: true }));
      recommendedActionInput!.value = " Launch the board room tab ";
      recommendedActionInput!.dispatchEvent(new Event("change", { bubbles: true }));
      nextActionInput!.value = " Implement the issue-level board room panel ";
      nextActionInput!.dispatchEvent(new Event("change", { bubbles: true }));
      risksInput!.value = " Extra review overhead \n\n Adoption confusion ";
      risksInput!.dispatchEvent(new Event("change", { bubbles: true }));
      proposedCommentInput!.value = "  Approved for a narrow pilot. ";
      proposedCommentInput!.dispatchEvent(new Event("change", { bubbles: true }));
      const participantCheckboxes = container.querySelectorAll('input[name="participantAgentIds"]');
      (participantCheckboxes[0] as HTMLInputElement | undefined)?.click();
    });

    const submitButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Create board request"),
    );

    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onRequestBoardDecision).toHaveBeenCalledWith({
      title: "Approve board room rollout",
      summary: "Pilot this on issue detail first.",
      roomTitle: "Migration Readiness Council",
      agenda: "Review blockers, risks, and the staged rollout plan.",
      recommendedAction: "Launch the board room tab",
      nextActionOnApproval: "Implement the issue-level board room panel",
      risks: ["Extra review overhead", "Adoption confusion"],
      proposedComment: "Approved for a narrow pilot.",
      participantAgentIds: ["agent-1"],
      decisionTier: "board",
      roomKind: "issue_board_room",
    });

    act(() => {
      root.unmount();
    });
  });

  it("loads approval comments lazily for an expanded board request", async () => {
    const root = createRoot(container);
    mockApprovalsApi.listComments.mockResolvedValue([
      createComment("comment-1", "Need evidence before approving."),
    ]);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <BoardRoomPanel
              approvals={[createApproval("approval-board", "request_board_approval", "Approve issue strategy")]}
              agentMap={new Map([["agent-1", createAgent()]])}
              onRequestBoardDecision={async () => {}}
              onApproveApproval={async () => {}}
              onRejectApproval={async () => {}}
              pendingApprovalAction={null}
            />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    expect(mockApprovalsApi.listComments).not.toHaveBeenCalled();

    const openThreadButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Open discussion"),
    );
    expect(openThreadButton).not.toBeUndefined();

    await act(async () => {
      openThreadButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockApprovalsApi.listComments).toHaveBeenCalledWith("approval-board");
    expect(container.textContent).toContain("Loading conference discussion");

    await flush();

    expect(container.textContent).toContain("Need evidence before approving.");

    act(() => {
      root.unmount();
    });
  });

  it("posts a board-room comment inline", async () => {
    const root = createRoot(container);
    mockApprovalsApi.listComments.mockResolvedValue([]);
    mockApprovalsApi.addComment.mockResolvedValue(createComment("comment-2", "Approved with a narrow rollout."));

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <BoardRoomPanel
              approvals={[createApproval("approval-board", "request_board_approval", "Approve issue strategy")]}
              agentMap={new Map([["agent-1", createAgent()]])}
              onRequestBoardDecision={async () => {}}
              onApproveApproval={async () => {}}
              onRejectApproval={async () => {}}
              pendingApprovalAction={null}
            />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    const openThreadButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Open discussion"),
    );
    await act(async () => {
      openThreadButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const commentInput = container.querySelector('textarea[name="boardComment-approval-board"]') as HTMLTextAreaElement | null;
    expect(commentInput).not.toBeNull();

    await act(async () => {
      setNativeTextareaValue(commentInput!, "Approved with a narrow rollout.");
    });

    const postCommentButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Post comment"),
    );
    expect(postCommentButton).not.toBeUndefined();

    await act(async () => {
      postCommentButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockApprovalsApi.addComment).toHaveBeenCalledWith(
      "approval-board",
      "Approved with a narrow rollout.",
    );
    expect(container.textContent).toContain("Approved with a narrow rollout.");

    act(() => {
      root.unmount();
    });
  });

  it("shows invited conference-room participants when present on the approval payload", async () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <BoardRoomPanel
              approvals={[{
                ...createApproval("approval-board", "request_board_approval", "Approve issue strategy"),
                payload: {
                  title: "Approve issue strategy",
                  participantAgentIds: ["agent-1"],
                  roomTitle: "Readiness Review",
                  agenda: "Confirm the migration plan.",
                },
              }]}
              agentMap={new Map([["agent-1", createAgent()]])}
              onRequestBoardDecision={async () => {}}
              onApproveApproval={async () => {}}
              onRejectApproval={async () => {}}
              pendingApprovalAction={null}
            />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    expect(container.textContent).toContain("Participants");
    expect(container.textContent).toContain("Director");
    expect(container.textContent).toContain("Readiness Review");
    expect(container.textContent).toContain("Confirm the migration plan.");

    act(() => {
      root.unmount();
    });
  });

  it("shows a live repo context preview in the composer", async () => {
    const root = createRoot(container);
    mockIssuesApi.getConferenceContext.mockResolvedValue(createConferenceContext());

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <BoardRoomPanel
              issueId="issue-1"
              approvals={[]}
              agentMap={new Map([["agent-1", createAgent()]])}
              onRequestBoardDecision={async () => {}}
              onApproveApproval={async () => {}}
              onRejectApproval={async () => {}}
              pendingApprovalAction={null}
            />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    const openButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Request board decision"),
    );

    await act(async () => {
      openButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.getConferenceContext).toHaveBeenCalledWith("issue-1");
    expect(container.textContent).toContain("Live Repo Context Preview");
    expect(container.textContent).toContain("Issue Worktree");
    expect(container.textContent).toContain("codex/conference-context");
    expect(container.textContent).toContain("server/src/routes/issues.ts");

    act(() => {
      root.unmount();
    });
  });
});

// @vitest-environment jsdom

import { act, createRef, forwardRef, useImperativeHandle } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IssueChatThread,
  VIRTUALIZED_THREAD_ROW_THRESHOLD,
  buildIssueChatRuntimeResetKey,
  resolveAssistantMessageFoldedState,
} from "./IssueChatThread";

const { markdownEditorFocusMock } = vi.hoisted(() => ({
  markdownEditorFocusMock: vi.fn(),
}));

const { threadMessagesMock, useMessageMock } = vi.hoisted(() => ({
  threadMessagesMock: vi.fn((_components?: { UserMessage: () => ReactNode }) => <div data-testid="thread-messages" />),
  useMessageMock: vi.fn(() => ({
    id: "message",
    role: "assistant",
    createdAt: new Date("2026-04-06T12:00:00.000Z"),
    content: [],
    metadata: { custom: {} },
    status: { type: "complete" },
  })),
}));

vi.mock("@assistant-ui/react", () => ({
  AssistantRuntimeProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ThreadPrimitive: {
    Root: ({ children, className }: { children: ReactNode; className?: string }) => (
      <div data-testid="thread-root" className={className}>{children}</div>
    ),
    Viewport: ({ children, className }: { children: ReactNode; className?: string }) => (
      <div data-testid="thread-viewport" className={className}>{children}</div>
    ),
    Empty: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Messages: ({ components }: { components: { UserMessage: () => ReactNode } }) => threadMessagesMock(components),
  },
  MessagePrimitive: {
    Root: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Content: () => null,
    Parts: () => null,
  },
  useAui: () => ({ thread: () => ({ append: vi.fn() }) }),
  useAuiState: () => false,
  useMessage: () => useMessageMock(),
}));

vi.mock("./transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: () => ({
    transcriptByRun: new Map(),
    hasOutputForRun: () => false,
  }),
}));

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: forwardRef(({
    value = "",
    onChange,
    placeholder,
    className,
    contentClassName,
  }: {
    value?: string;
    onChange?: (value: string) => void;
    placeholder?: string;
    className?: string;
    contentClassName?: string;
  }, ref) => {
    useImperativeHandle(ref, () => ({
      focus: markdownEditorFocusMock,
    }));

    return (
      <textarea
        aria-label="Issue chat editor"
        data-class-name={className}
        data-content-class-name={contentClassName}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
      />
    );
  }),
}));

vi.mock("./InlineEntitySelector", () => ({
  InlineEntitySelector: () => null,
}));

vi.mock("./Identity", () => ({
  Identity: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock("./OutputFeedbackButtons", () => ({
  OutputFeedbackButtons: () => null,
}));

vi.mock("./AgentIconPicker", () => ({
  AgentIcon: () => null,
}));

vi.mock("./StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("../hooks/usePaperclipIssueRuntime", () => ({
  usePaperclipIssueRuntime: () => ({}),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createThreadComments(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `comment-${index + 1}`,
    companyId: "company-1",
    issueId: "issue-1",
    authorAgentId: index % 2 === 0 ? null : "agent-1",
    authorUserId: index % 2 === 0 ? "user-1" : null,
    body: `Message ${index + 1}`,
    createdAt: new Date(Date.UTC(2026, 3, 6, 12, index % 60, 0)),
    updatedAt: new Date(Date.UTC(2026, 3, 6, 12, index % 60, 0)),
  }));
}

describe("IssueChatThread", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
    threadMessagesMock.mockImplementation(() => <div data-testid="thread-messages" />);
  });

  afterEach(() => {
    container.remove();
    vi.useRealTimers();
    markdownEditorFocusMock.mockReset();
    threadMessagesMock.mockReset();
    useMessageMock.mockClear();
  });

  it("drops the count heading and does not use an internal scrollbox", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            showComposer={false}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain("Jump to latest");
    expect(container.textContent).not.toContain("Chat (");

    const viewport = container.querySelector('[data-testid="thread-viewport"]') as HTMLDivElement | null;
    expect(viewport).not.toBeNull();
    expect(viewport?.className).not.toContain("overflow-y-auto");
    expect(viewport?.className).not.toContain("max-h-[70vh]");

    act(() => {
      root.unmount();
    });
  });

  it("keeps the assistant-ui message renderer for threads at the virtualization threshold", () => {
    const root = createRoot(container);
    const comments = createThreadComments(VIRTUALIZED_THREAD_ROW_THRESHOLD);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={comments}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            showComposer={false}
            showJumpToLatest={false}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    expect(container.querySelector('[data-testid="issue-chat-thread-virtualizer"]')).toBeNull();
    expect(container.querySelector('[data-testid="thread-messages"]')).not.toBeNull();
    expect(threadMessagesMock).toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it("virtualizes long merged threads without mounting every chat row", () => {
    const root = createRoot(container);
    const comments = createThreadComments(VIRTUALIZED_THREAD_ROW_THRESHOLD + 1);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={comments}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            showComposer={false}
            showJumpToLatest={false}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    const virtualizer = container.querySelector(
      '[data-testid="issue-chat-thread-virtualizer"]',
    ) as HTMLDivElement | null;
    expect(virtualizer).not.toBeNull();
    expect(virtualizer?.dataset.virtualCount).toBe(String(comments.length));
    expect(container.querySelector('[data-testid="thread-messages"]')).toBeNull();

    const rows = container.querySelectorAll('[data-testid="issue-chat-message-row"]');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(comments.length);

    act(() => {
      root.unmount();
    });
  });

  it("uses the virtualized index for long-thread hash anchors", () => {
    const root = createRoot(container);
    const comments = createThreadComments(VIRTUALIZED_THREAD_ROW_THRESHOLD + 1);
    const target = comments[comments.length - 1];
    const scrollToMock = vi.spyOn(window, "scrollTo").mockImplementation(() => {});

    act(() => {
      root.render(
        <MemoryRouter initialEntries={[`/issues/ISSUE-1#comment-${target.id}`]}>
          <IssueChatThread
            comments={comments}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            showComposer={false}
            showJumpToLatest={false}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    expect(scrollToMock).toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));

    scrollToMock.mockRestore();
    act(() => {
      root.unmount();
    });
  });

  it("uses the virtualizer and bottom anchor path for jump to latest on long threads", () => {
    const root = createRoot(container);
    const comments = createThreadComments(VIRTUALIZED_THREAD_ROW_THRESHOLD + 1);
    const scrollToMock = vi.spyOn(window, "scrollTo").mockImplementation(() => {});

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={comments}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    const jump = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Jump to latest",
    ) as HTMLButtonElement | undefined;
    expect(jump).toBeDefined();

    act(() => {
      jump?.click();
    });

    expect(scrollToMock).toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));

    scrollToMock.mockRestore();
    act(() => {
      root.unmount();
    });
  });

  it("supports the embedded read-only variant without the jump control", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            showComposer={false}
            showJumpToLatest={false}
            variant="embedded"
            emptyMessage="No run output captured."
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain("No run output captured.");
    expect(container.textContent).not.toContain("Jump to latest");

    const viewport = container.querySelector('[data-testid="thread-viewport"]') as HTMLDivElement | null;
    expect(viewport?.className).toContain("space-y-3");

    act(() => {
      root.unmount();
    });
  });

  it("falls back to a safe transcript warning when assistant-ui throws during message rendering", () => {
    const root = createRoot(container);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    threadMessagesMock.mockImplementation(() => {
      throw new Error("tapClientLookup: Index 8 out of bounds (length: 8)");
    });

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[{
              id: "comment-1",
              companyId: "company-1",
              issueId: "issue-1",
              authorAgentId: "agent-1",
              authorUserId: null,
              body: "Agent summary",
              createdAt: new Date("2026-04-06T12:00:00.000Z"),
              updatedAt: new Date("2026-04-06T12:00:00.000Z"),
            }]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            showComposer={false}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain("Chat renderer hit an internal state error.");
    expect(container.textContent).toContain("Agent summary");
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
    act(() => {
      root.unmount();
    });
  });

  it("shows deferred wake badge only for hold-deferred queued comments", () => {
    const root = createRoot(container);
    threadMessagesMock.mockImplementation((components?: { UserMessage: () => ReactNode }) => {
      if (!components) return <div data-testid="thread-messages" />;
      const UserMessage = components.UserMessage;
      return <UserMessage />;
    });
    useMessageMock.mockReturnValue({
      id: "comment-hold",
      role: "user",
      createdAt: new Date("2026-04-06T12:00:00.000Z"),
      content: [],
      metadata: {
        custom: {
          anchorId: "comment-hold",
          queueState: "queued",
          queueReason: "hold",
        },
      },
      status: { type: "complete" },
    });

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[{
              id: "comment-hold",
              companyId: "company-1",
              issueId: "issue-1",
              authorAgentId: null,
              authorUserId: "user-1",
              body: "Need a quick update",
              queueState: "queued",
              queueReason: "hold",
              createdAt: new Date("2026-04-06T12:00:00.000Z"),
              updatedAt: new Date("2026-04-06T12:00:00.000Z"),
            }]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            showComposer={false}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain("Deferred wake");

    useMessageMock.mockReturnValue({
      id: "comment-active-run",
      role: "user",
      createdAt: new Date("2026-04-06T12:01:00.000Z"),
      content: [],
      metadata: {
        custom: {
          anchorId: "comment-active-run",
          queueState: "queued",
          queueReason: "active_run",
        },
      },
      status: { type: "complete" },
    });

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[{
              id: "comment-active-run",
              companyId: "company-1",
              issueId: "issue-1",
              authorAgentId: null,
              authorUserId: "user-1",
              body: "Queue behind active run",
              queueState: "queued",
              queueReason: "active_run",
              createdAt: new Date("2026-04-06T12:01:00.000Z"),
              updatedAt: new Date("2026-04-06T12:01:00.000Z"),
            }]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            showComposer={false}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain("Queued");
    expect(container.textContent).not.toContain("Deferred wake");

    act(() => {
      root.unmount();
    });
  });

  it("stores and restores the composer draft per issue key", () => {
    vi.useFakeTimers();
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            draftKey="issue-chat-draft:test-1"
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    const editor = container.querySelector('textarea[aria-label="Issue chat editor"]') as HTMLTextAreaElement | null;
    expect(editor).not.toBeNull();
    expect(editor?.placeholder).toBe("Reply");

    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(editor, "Draft survives refresh");
      editor?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    act(() => {
      vi.advanceTimersByTime(900);
    });

    expect(localStorage.getItem("issue-chat-draft:test-1")).toBe("Draft survives refresh");

    act(() => {
      root.unmount();
    });

    const remount = createRoot(container);
    act(() => {
      remount.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            draftKey="issue-chat-draft:test-1"
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    const restoredEditor = container.querySelector('textarea[aria-label="Issue chat editor"]') as HTMLTextAreaElement | null;
    expect(restoredEditor?.value).toBe("Draft survives refresh");

    act(() => {
      remount.unmount();
    });
  });

  it("keeps the composer inline with bottom breathing room and a capped editor height", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    const composer = container.querySelector('[data-testid="issue-chat-composer"]') as HTMLDivElement | null;
    expect(composer).not.toBeNull();
    expect(composer?.className).not.toContain("sticky");
    expect(composer?.className).not.toContain("bottom-0");
    expect(composer?.className).toContain("pb-[calc(env(safe-area-inset-bottom)+1.5rem)]");

    const editor = container.querySelector('textarea[aria-label="Issue chat editor"]') as HTMLTextAreaElement | null;
    expect(editor?.dataset.contentClassName).toContain("max-h-[28dvh]");
    expect(editor?.dataset.contentClassName).toContain("overflow-y-auto");

    act(() => {
      root.unmount();
    });
  });

  it("shows a stop control for active runs and clears it when the run disappears", () => {
    const root = createRoot(container);
    const onCancelRun = vi.fn().mockResolvedValue(undefined);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[{
              id: "run-1",
              status: "running",
              invocationSource: "manual",
              triggerDetail: null,
              startedAt: "2026-04-06T12:04:00.000Z",
              finishedAt: null,
              createdAt: "2026-04-06T12:04:00.000Z",
              agentId: "agent-1",
              agentName: "CTO",
              adapterType: "codex_local",
              issueId: "issue-1",
            }]}
            onAdd={async () => {}}
            onCancelRun={onCancelRun}
            cancellingRunId={null}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    const stopButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Stop"));
    expect(stopButton).toBeTruthy();

    act(() => {
      stopButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onCancelRun).toHaveBeenCalledTimes(1);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            onCancelRun={onCancelRun}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).not.toContain("Stop");
    const editor = container.querySelector('textarea[aria-label="Issue chat editor"]') as HTMLTextAreaElement | null;
    expect(editor).not.toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("exposes a composer focus handle that forwards to the editor", () => {
    const root = createRoot(container);
    const composerRef = createRef<{ focus: () => void }>();
    const scrollByMock = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    const requestAnimationFrameMock = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            composerRef={composerRef}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    const composer = container.querySelector('[data-testid="issue-chat-composer"]') as HTMLDivElement | null;
    expect(composerRef.current).not.toBeNull();
    expect(composer).not.toBeNull();

    const scrollIntoViewMock = vi.fn();
    composer!.scrollIntoView = scrollIntoViewMock;

    act(() => {
      composerRef.current?.focus();
    });

    expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: "smooth", block: "end" });
    expect(scrollByMock).toHaveBeenCalledWith({ top: 96, behavior: "smooth" });
    expect(markdownEditorFocusMock).toHaveBeenCalledTimes(1);
    scrollByMock.mockRestore();
    requestAnimationFrameMock.mockRestore();

    act(() => {
      root.unmount();
    });
  });

  it("folds chain-of-thought when the same message transitions from running to complete", () => {
    expect(resolveAssistantMessageFoldedState({
      messageId: "message-1",
      currentFolded: false,
      isFoldable: true,
      previousMessageId: "message-1",
      previousIsFoldable: false,
    })).toBe(true);
  });

  it("preserves a manually opened completed message across rerenders", () => {
    expect(resolveAssistantMessageFoldedState({
      messageId: "message-1",
      currentFolded: false,
      isFoldable: true,
      previousMessageId: "message-1",
      previousIsFoldable: true,
    })).toBe(false);
  });

  it("derives a stable runtime reset key from active runs only", () => {
    expect(buildIssueChatRuntimeResetKey([
      { id: "run-1", status: "running" },
      { id: "run-2", status: "succeeded" },
    ])).toBe("issue-chat-runtime:run-1:running");

    expect(buildIssueChatRuntimeResetKey([
      { id: "run-1", status: "cancelled" },
    ])).toBe("issue-chat-runtime:idle");
  });
});

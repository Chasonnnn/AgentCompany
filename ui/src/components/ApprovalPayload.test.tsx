// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalPayloadRenderer, approvalLabel } from "./ApprovalPayload";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("approvalLabel", () => {
  it("uses payload titles for generic board approvals", () => {
    expect(
      approvalLabel("request_board_approval", {
        title: "Reply with an ASCII frog",
      }),
    ).toBe("Conference Room: Reply with an ASCII frog");
  });
});

describe("ApprovalPayloadRenderer", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders request_board_approval payload fields without falling back to raw JSON", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          payload={{
            title: "Reply with an ASCII frog",
            summary: "Board asked for approval before posting the frog.",
            roomTitle: "Frog Launch Council",
            agenda: "Decide whether the frog is ready for production.",
            recommendedAction: "Approve the frog reply.",
            nextActionOnApproval: "Post the frog comment on the issue.",
            risks: ["The frog might be too powerful."],
            proposedComment: "(o)<",
            repoContext: {
              capturedAt: "2026-04-08T12:00:00.000Z",
              projectWorkspace: {
                id: "11111111-1111-4111-8111-111111111111",
                projectId: "22222222-2222-4222-8222-222222222222",
                name: "Primary Repo",
                sourceType: "local_path",
                isPrimary: true,
                repoUrl: "https://github.com/acme/frog",
                repoRef: "main",
                defaultRef: "main",
              },
              executionWorkspace: {
                id: "33333333-3333-4333-8333-333333333333",
                projectId: "22222222-2222-4222-8222-222222222222",
                projectWorkspaceId: "11111111-1111-4111-8111-111111111111",
                name: "Frog Worktree",
                mode: "isolated_workspace",
                status: "active",
                providerType: "git_worktree",
                repoUrl: "https://github.com/acme/frog",
                baseRef: "origin/main",
                branchName: "codex/frog",
              },
              git: {
                rootPath: "/private/tmp/frog",
                workspacePath: "/private/tmp/frog/worktree",
                displayRootPath: "frog",
                displayWorkspacePath: "frog/worktree",
                branchName: "codex/frog",
                baseRef: "origin/main",
                isGit: true,
                dirty: true,
                dirtyEntryCount: 1,
                untrackedEntryCount: 0,
                aheadCount: 2,
                behindCount: 0,
                changedFileCount: 1,
                truncated: false,
                changedFiles: [
                  {
                    path: "src/frog.ts",
                    previousPath: null,
                    indexStatus: "M",
                    worktreeStatus: " ",
                    status: "M ",
                  },
                ],
              },
            },
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Reply with an ASCII frog");
    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).toContain("Frog Launch Council");
    expect(container.textContent).toContain("Decide whether the frog is ready for production.");
    expect(container.textContent).toContain("Approve the frog reply.");
    expect(container.textContent).toContain("Post the frog comment on the issue.");
    expect(container.textContent).toContain("The frog might be too powerful.");
    expect(container.textContent).toContain("(o)<");
    expect(container.textContent).toContain("Captured Repo Context");
    expect(container.textContent).toContain("frog/worktree");
    expect(container.textContent).toContain("src/frog.ts");
    expect(container.textContent).not.toContain("\"recommendedAction\"");
    expect(container.textContent).not.toContain("/private/tmp/frog/worktree");

    act(() => {
      root.unmount();
    });
  });

  it("can hide the repeated title when the card header already shows it", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          hidePrimaryTitle
          payload={{
            title: "Reply with an ASCII frog",
            summary: "Board asked for approval before posting the frog.",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).not.toContain("TitleReply with an ASCII frog");

    act(() => {
      root.unmount();
    });
  });
});

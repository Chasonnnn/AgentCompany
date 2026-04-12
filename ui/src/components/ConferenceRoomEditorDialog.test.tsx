// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { CompanyOperatingHierarchy, Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConferenceRoomEditorDialog } from "./ConferenceRoomEditorDialog";

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

const hierarchy: CompanyOperatingHierarchy = {
  executiveOffice: [],
  projectPods: [],
  sharedServices: [],
  unassigned: [],
};

const issues: Issue[] = [
  {
    id: "issue-1",
    identifier: "AIW-1",
    title: "Hire your first engineer and create a hiring plan",
  } as Issue,
];

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("ConferenceRoomEditorDialog", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("opens without looping when requiredIssueIds is omitted", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ConferenceRoomEditorDialog
          open
          onOpenChange={() => {}}
          hierarchy={hierarchy}
          issues={issues}
          isPending={false}
          onSubmit={vi.fn().mockResolvedValue(undefined)}
        />,
      );
    });

    await flush();

    expect(container.textContent).toContain("Open conference room");
    expect(container.textContent).toContain("Linked issues");

    await act(async () => {
      root.unmount();
    });
  });
});

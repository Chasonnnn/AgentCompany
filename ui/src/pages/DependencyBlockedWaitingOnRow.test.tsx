// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import type { DashboardSummary } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, className, ...props }: ComponentProps<"a"> & { to: string }) => (
    <a href={to} className={className} {...props}>{children}</a>
  ),
}));

import { DependencyBlockedWaitingOnRow } from "./DependencyBlockedWaitingOnRow";

type ComputedAgentStates = DashboardSummary["tasks"]["computedAgentStates"];
type WaitingOnEntry = ComputedAgentStates[number]["waitingOn"][number];

function buildEntries(waitingOn: WaitingOnEntry[]): ComputedAgentStates {
  return [
    { state: "idle", count: 0, detailedStates: [], waitingOn: [] },
    { state: "queued", count: 0, detailedStates: [], waitingOn: [] },
    { state: "dependency_blocked", count: waitingOn.length, detailedStates: [], waitingOn },
    { state: "running", count: 0, detailedStates: [], waitingOn: [] },
  ];
}

describe("DependencyBlockedWaitingOnRow", () => {
  let container!: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.removeChild(container);
  });

  it("renders null when waitingOn is empty", () => {
    const entries = buildEntries([]);
    act(() => {
      createRoot(container).render(<DependencyBlockedWaitingOnRow entries={entries} />);
    });
    expect(container.querySelector('[data-testid="computed-agent-state-waiting-on"]')).toBeNull();
  });

  it("renders a single entry with identifier link and open-children detail only when dependentCount <= 1", () => {
    const entries = buildEntries([
      { issueId: "issue-1", identifier: "BLK-1", openChildCount: 2, dependentCount: 1 },
    ]);
    act(() => {
      createRoot(container).render(<DependencyBlockedWaitingOnRow entries={entries} />);
    });

    const row = container.querySelector('[data-testid="computed-agent-state-waiting-on"]');
    expect(row).not.toBeNull();
    const links = row!.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute("href")).toBe("/issues/BLK-1");
    expect(links[0]!.textContent).toContain("BLK-1");
    expect(links[0]!.textContent).toContain("2 open children");
    // dependentCount of 1 must NOT render a "N dependents" suffix.
    expect(links[0]!.textContent).not.toContain("dependents");
  });

  it("renders multi entries, pluralizes correctly, and falls back to issueId.slice(0,8) when identifier is null", () => {
    const entries = buildEntries([
      { issueId: "issue-plural", identifier: "BLK-9", openChildCount: 1, dependentCount: 3 },
      { issueId: "a1b2c3d4e5f6g7h8", identifier: null, openChildCount: 0, dependentCount: 2 },
    ]);
    act(() => {
      createRoot(container).render(<DependencyBlockedWaitingOnRow entries={entries} />);
    });

    const row = container.querySelector('[data-testid="computed-agent-state-waiting-on"]');
    expect(row).not.toBeNull();
    const links = row!.querySelectorAll("a");
    expect(links).toHaveLength(2);

    // First link: identifier present, singular child + plural dependents.
    expect(links[0]!.getAttribute("href")).toBe("/issues/BLK-9");
    expect(links[0]!.textContent).toContain("BLK-9");
    expect(links[0]!.textContent).toContain("1 open child");
    expect(links[0]!.textContent).not.toContain("open children");
    expect(links[0]!.textContent).toContain("3 dependents");

    // Second link: null identifier → label falls back to issueId.slice(0,8);
    // link href also uses the raw issueId since identifier is null.
    expect(links[1]!.getAttribute("href")).toBe("/issues/a1b2c3d4e5f6g7h8");
    expect(links[1]!.textContent).toContain("a1b2c3d4");
    // openChildCount=0 → no child-count detail, just the dependents suffix.
    expect(links[1]!.textContent).not.toContain("open child");
    expect(links[1]!.textContent).toContain("2 dependents");
  });

  it("renders null when there is no dependency_blocked entry at all", () => {
    const entries: ComputedAgentStates = [
      { state: "idle", count: 0, detailedStates: [], waitingOn: [] },
    ];
    act(() => {
      createRoot(container).render(<DependencyBlockedWaitingOnRow entries={entries} />);
    });
    expect(container.querySelector('[data-testid="computed-agent-state-waiting-on"]')).toBeNull();
  });
});

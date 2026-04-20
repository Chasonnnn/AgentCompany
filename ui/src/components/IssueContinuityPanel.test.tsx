// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  buildIssueDocumentTemplate,
  type Agent,
  type Issue,
  type IssueContinuityBundle,
  type IssueContinuityDocumentSnapshot,
  type IssueContinuityRemediation,
  type IssueContinuityState,
  type IssueDecisionQuestion,
} from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueContinuityPanel } from "./IssueContinuityPanel";
import type { IssueContinuityResponse } from "../api/issues";

const mockIssuesApi = vi.hoisted(() => ({
  getContinuity: vi.fn(),
  getBranchMergePreview: vi.fn(),
  prepareContinuity: vi.fn(),
  requestSpecThaw: vi.fn(),
  handoffContinuity: vi.fn(),
  addProgressCheckpoint: vi.fn(),
  reviewReturn: vi.fn(),
  reviewResubmit: vi.fn(),
  repairHandoff: vi.fn(),
  cancelHandoff: vi.fn(),
  mutateContinuityBranch: vi.fn(),
  returnContinuityBranch: vi.fn(),
  mergeContinuityBranch: vi.fn(),
  requestPlanApproval: vi.fn(),
  createQuestion: vi.fn(),
  answerQuestion: vi.fn(),
  dismissQuestion: vi.fn(),
  escalateQuestionApproval: vi.fn(),
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string } & ComponentProps<"a">) => (
    <a href={to} {...props}>{children}</a>
  ),
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

vi.mock("@/components/ui/label", () => ({
  Label: ({ children, ...props }: ComponentProps<"label">) => <label {...props}>{children}</label>,
}));

vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  } & ComponentProps<"input">) => (
    <input
      {...props}
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange?.(event.target.checked)}
    />
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "CEO",
    urlKey: "ceo",
    role: "ceo",
    title: "CEO",
    icon: null,
    status: "active",
    reportsTo: null,
    orgLevel: "executive",
    templateId: null,
    templateRevisionId: null,
    operatingClass: "executive",
    capabilityProfileKey: undefined,
    archetypeKey: null,
    departmentKey: "executive",
    departmentName: "Executive",
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: {
      canCreateAgents: true,
    },
    requestedByPrincipalType: null,
    requestedByPrincipalId: null,
    requestedForProjectId: null,
    requestedReason: null,
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-04-17T12:00:00.000Z"),
    updatedAt: new Date("2026-04-17T12:00:00.000Z"),
    ...overrides,
  };
}

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "PAP-101",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Planning-first issue",
    description: "Ship the planning-first issue detail flow.",
    status: "todo",
    priority: "medium",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    issueNumber: 101,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionPolicy: null,
    executionState: null,
    continuityState: null,
    continuitySummary: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    labels: [],
    labelIds: [],
    planDocument: null,
    documentSummaries: [],
    legacyPlanDocument: null,
    createdAt: new Date("2026-04-17T12:00:00.000Z"),
    updatedAt: new Date("2026-04-17T12:00:00.000Z"),
    ...overrides,
  };
}

function createContinuityState(overrides: Partial<IssueContinuityState> = {}): IssueContinuityState {
  return {
    tier: "normal",
    status: "ready",
    health: "healthy",
    healthReason: null,
    healthDetails: [],
    requiredDocumentKeys: ["spec", "plan", "progress", "test-plan"],
    missingDocumentKeys: [],
    specState: "editable",
    branchRole: "none",
    branchStatus: "none",
    unresolvedBranchIssueIds: [],
    returnedBranchIssueIds: [],
    openReviewFindingsRevisionId: null,
    openDecisionQuestionCount: 0,
    blockingDecisionQuestionCount: 0,
    lastDecisionQuestionAt: null,
    lastDecisionAnswerAt: null,
    lastProgressAt: null,
    lastHandoffAt: null,
    lastReviewFindingsAt: null,
    lastReviewReturnAt: null,
    lastBranchReturnAt: null,
    lastPreparedAt: "2026-04-17T12:00:00.000Z",
    lastBundleHash: "bundle-1",
    planApproval: {
      approvalId: null,
      status: null,
      currentPlanRevisionId: "plan-revision-1",
      requestedPlanRevisionId: null,
      approvedPlanRevisionId: null,
      specRevisionId: null,
      testPlanRevisionId: null,
      decisionNote: null,
      lastRequestedAt: null,
      lastDecidedAt: null,
      currentRevisionApproved: false,
      requiresApproval: false,
      requiresResubmission: false,
    },
    ...overrides,
  };
}

function createSnapshot(key: string, body: string): IssueContinuityDocumentSnapshot {
  return {
    key,
    title: null,
    body,
    latestRevisionId: `${key}-revision-1`,
    latestRevisionNumber: 1,
    updatedAt: "2026-04-17T12:00:00.000Z",
  };
}

function createContinuityBundle(
  state: IssueContinuityState,
  issue: Issue,
  issueDocumentBodies: Partial<Record<string, string | null>>,
  decisionQuestions: IssueDecisionQuestion[] = [],
): IssueContinuityBundle {
  return {
    issueId: issue.id,
    generatedAt: "2026-04-17T12:00:00.000Z",
    bundleHash: "bundle-1",
    continuityState: state,
    executionState: null,
    planApproval: state.planApproval,
    decisionQuestions,
    issueDocuments: {
      spec: issueDocumentBodies.spec ? createSnapshot("spec", issueDocumentBodies.spec) : null,
      plan: issueDocumentBodies.plan ? createSnapshot("plan", issueDocumentBodies.plan) : null,
      runbook: issueDocumentBodies.runbook ? createSnapshot("runbook", issueDocumentBodies.runbook) : null,
      progress: issueDocumentBodies.progress ? createSnapshot("progress", issueDocumentBodies.progress) : null,
      "test-plan": issueDocumentBodies["test-plan"] ? createSnapshot("test-plan", issueDocumentBodies["test-plan"]!) : null,
      handoff: issueDocumentBodies.handoff ? createSnapshot("handoff", issueDocumentBodies.handoff) : null,
      "review-findings": issueDocumentBodies["review-findings"] ? createSnapshot("review-findings", issueDocumentBodies["review-findings"]!) : null,
      "branch-return": issueDocumentBodies["branch-return"] ? createSnapshot("branch-return", issueDocumentBodies["branch-return"]!) : null,
    },
    projectDocuments: {
      context: null,
      runbook: null,
    },
    referencedRevisionIds: {},
  };
}

function createDecisionQuestion(overrides: Partial<IssueDecisionQuestion> = {}): IssueDecisionQuestion {
  return {
    id: "question-1",
    companyId: "company-1",
    issueId: "issue-1",
    target: "board",
    requestedByAgentId: "agent-1",
    requestedByUserId: null,
    status: "open",
    blocking: true,
    title: "Pick the rollout path",
    question: "Which rollout path should we use?",
    whyBlocked: "The execution plan depends on the rollout shape.",
    recommendedOptions: [
      {
        key: "incremental",
        label: "Incremental",
        description: "Lower risk, slower cleanup.",
      },
      {
        key: "rebuild",
        label: "Rebuild",
        description: "Faster reset, higher migration risk.",
      },
    ],
    suggestedDefault: "incremental",
    answer: null,
    answeredByUserId: null,
    answeredAt: null,
    linkedApprovalId: null,
    createdAt: new Date("2026-04-17T12:00:00.000Z"),
    updatedAt: new Date("2026-04-17T12:00:00.000Z"),
    ...overrides,
  };
}

function createContinuityResponse(options?: {
  issue?: Issue;
  state?: IssueContinuityState;
  issueDocumentBodies?: Partial<Record<string, string | null>>;
  activeGateParticipant?: IssueContinuityResponse["activeGateParticipant"];
  remediation?: IssueContinuityRemediation;
  decisionQuestions?: IssueDecisionQuestion[];
}): IssueContinuityResponse {
  const issue = options?.issue ?? createIssue();
  const state = options?.state ?? createContinuityState();
  return {
    issueId: issue.id,
    continuityState: state,
    continuityBundle: createContinuityBundle(
      state,
      issue,
      options?.issueDocumentBodies ?? {},
      options?.decisionQuestions ?? [],
    ),
    continuityOwner: {
      assigneeAgentId: issue.assigneeAgentId,
      assigneeUserId: issue.assigneeUserId,
    },
    activeGateParticipant: options?.activeGateParticipant ?? null,
    remediation: options?.remediation ?? {
      suggestedActions: [],
      blockedActions: [],
    },
  };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("IssueContinuityPanel", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let queryClient: QueryClient | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.clearAllMocks();

    for (const mockFn of Object.values(mockIssuesApi)) {
      mockFn.mockResolvedValue({});
    }
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = null;
    }
    queryClient?.clear();
    queryClient = null;
    container.remove();
  });

  async function renderPanel(options: {
    response: IssueContinuityResponse;
    issue?: Issue;
    onOpenArtifacts?: (documentKey?: string) => void;
    agents?: Agent[];
    childIssues?: Issue[];
  }) {
    const issue = options.issue ?? createIssue({ continuityState: options.response.continuityState });
    mockIssuesApi.getContinuity.mockResolvedValue(options.response);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
        mutations: {
          retry: false,
        },
      },
    });
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient!}>
          <IssueContinuityPanel
            issue={issue}
            agents={options.agents ?? [createAgent()]}
            childIssues={options.childIssues ?? []}
            onOpenArtifacts={options.onOpenArtifacts}
          />
        </QueryClientProvider>,
      );
    });

    await flush();
    await flush();

    return { issue };
  }

  it("renders a calm planning setup for freshly scaffolded docs", async () => {
    const issue = createIssue();
    const response = createContinuityResponse({
      issue,
      issueDocumentBodies: {
        spec: buildIssueDocumentTemplate("spec", { title: issue.title, description: issue.description, tier: "normal" }),
        plan: buildIssueDocumentTemplate("plan", { title: issue.title, description: issue.description, tier: "normal" }),
        progress: buildIssueDocumentTemplate("progress", { title: issue.title, description: issue.description, tier: "normal" }),
        "test-plan": buildIssueDocumentTemplate("test-plan", { title: issue.title, description: issue.description, tier: "normal" }),
      },
    });

    await renderPanel({ issue, response });

    expect(container.textContent).toContain("Continuity");
    expect(container.textContent).toContain("Planning setup");
    expect(container.textContent).toContain("Planning docs started 0/4");
    expect(container.textContent).toContain("Open planning docs");
    expect(container.textContent).not.toContain("Active gate: None");
    expect(container.textContent).not.toContain("Planning required");
    expect(container.textContent).not.toContain("Prepare execution");
    expect(container.textContent).toContain("Not started");
    expect(container.firstElementChild?.className).toContain("bg-muted/20");
    expect(container.firstElementChild?.className).not.toContain("border-red-500/30");
    expect(container.querySelector("[data-testid='continuity-advanced-panel']")).toBeNull();
  });

  it("opens artifacts at the plan doc from the primary planning action", async () => {
    const issue = createIssue();
    const onOpenArtifacts = vi.fn();
    const response = createContinuityResponse({
      issue,
      issueDocumentBodies: {
        spec: buildIssueDocumentTemplate("spec", { title: issue.title, description: issue.description, tier: "normal" }),
        plan: buildIssueDocumentTemplate("plan", { title: issue.title, description: issue.description, tier: "normal" }),
        progress: buildIssueDocumentTemplate("progress", { title: issue.title, description: issue.description, tier: "normal" }),
        "test-plan": buildIssueDocumentTemplate("test-plan", { title: issue.title, description: issue.description, tier: "normal" }),
      },
    });

    await renderPanel({ issue, response, onOpenArtifacts });

    const openPlanningDocsButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Open planning docs"));
    expect(openPlanningDocsButton).toBeTruthy();

    await act(async () => {
      openPlanningDocsButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onOpenArtifacts).toHaveBeenCalledWith("plan");
  });

  it("keeps advanced controls collapsed and hides the spec thaw reason until opened", async () => {
    const response = createContinuityResponse({
      issue: createIssue(),
    });

    await renderPanel({ response });

    expect(container.querySelector("[data-testid='continuity-advanced-panel']")).toBeNull();
    expect(container.querySelector("input[placeholder='Optional spec thaw reason']")).toBeNull();

    const advancedToggle = container.querySelector("[data-testid='continuity-advanced-toggle']");
    expect(advancedToggle).toBeTruthy();

    await act(async () => {
      advancedToggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelector("[data-testid='continuity-advanced-panel']")).toBeTruthy();
    expect(container.querySelector("input[placeholder='Optional spec thaw reason']")).toBeNull();

    const specThawButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Request spec thaw"));
    expect(specThawButton).toBeTruthy();

    await act(async () => {
      specThawButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelector("input[placeholder='Optional spec thaw reason']")).toBeTruthy();
  });

  it("shows prepare planning docs for legacy issues with genuinely missing documents", async () => {
    const issue = createIssue();
    const response = createContinuityResponse({
      issue,
      state: createContinuityState({
        status: "planning",
        health: "missing_required_docs",
        missingDocumentKeys: ["spec", "plan", "progress", "test-plan"],
      }),
      issueDocumentBodies: {},
    });

    await renderPanel({ issue, response });

    expect(container.textContent).toContain("Prepare planning docs");
    expect(container.textContent).toContain("Missing");
    expect(container.firstElementChild?.className).toContain("amber");
    expect(container.firstElementChild?.className).not.toContain("border-red-500/30");
  });

  it("auto-expands advanced actions when a gate participant is active", async () => {
    const response = createContinuityResponse({
      issue: createIssue(),
      activeGateParticipant: {
        type: "agent",
        agentId: "agent-1",
        userId: null,
      },
    });

    await renderPanel({ response });

    expect(container.textContent).toContain("Gate: CEO");
    expect(container.querySelector("[data-testid='continuity-advanced-panel']")).toBeTruthy();
  });

  it("shows plan approval actions for planning issues waiting on board review", async () => {
    const issue = createIssue();
    const response = createContinuityResponse({
      issue,
      state: createContinuityState({
        status: "awaiting_decision",
        planApproval: {
          approvalId: "11111111-1111-4111-8111-111111111111",
          status: "revision_requested",
          currentPlanRevisionId: "22222222-2222-4222-8222-222222222222",
          requestedPlanRevisionId: "22222222-2222-4222-8222-222222222222",
          approvedPlanRevisionId: "33333333-3333-4333-8333-333333333333",
          specRevisionId: null,
          testPlanRevisionId: null,
          decisionNote: "Tighten the rollout plan before execution.",
          lastRequestedAt: "2026-04-17T12:00:00.000Z",
          lastDecidedAt: "2026-04-17T12:10:00.000Z",
          currentRevisionApproved: false,
          requiresApproval: true,
          requiresResubmission: true,
        },
      }),
      issueDocumentBodies: {
        spec: "Spec started",
        plan: "Plan started",
        progress: "Progress started",
        "test-plan": "Test plan started",
      },
    });

    await renderPanel({ issue, response });

    expect(container.textContent).toContain("Plan approval");
    expect(container.textContent).toContain("Revision requested");
    expect(container.textContent).toContain("Tighten the rollout plan before execution.");
    expect(container.textContent).toContain("Open plan approval");
    expect(container.textContent).toContain("Revise plan and resubmit");
  });

  it("uses an option-first answer form and removes note fields", async () => {
    const question = createDecisionQuestion();
    const response = createContinuityResponse({
      issue: createIssue(),
      decisionQuestions: [question],
    });

    await renderPanel({ response });

    const openQuestionButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Answer / dismiss"));
    expect(openQuestionButton).toBeTruthy();

    await act(async () => {
      openQuestionButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelector("textarea[placeholder='Add your own comment']")).toBeTruthy();
    expect(container.querySelector("textarea[placeholder='Optional note']")).toBeNull();
    expect(container.querySelector("textarea[placeholder='Dismissal note (optional)']")).toBeNull();
    expect(container.querySelector("textarea[placeholder='Approval escalation summary (optional)']")).toBeNull();

    const answerButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Answer");
    expect(answerButton?.hasAttribute("disabled")).toBe(true);

    const incrementalOption = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Incremental"));
    expect(incrementalOption).toBeTruthy();

    await act(async () => {
      incrementalOption?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(answerButton?.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      answerButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockIssuesApi.answerQuestion).toHaveBeenCalledWith(question.id, {
      selectedOptionKey: "incremental",
    });
  });

  it("clears the selected option when a custom comment is entered and uses empty dismiss/escalation payloads", async () => {
    const question = createDecisionQuestion();
    const response = createContinuityResponse({
      issue: createIssue(),
      decisionQuestions: [question],
    });

    await renderPanel({ response });

    const findOpenQuestionButton = () => Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Answer / dismiss"));
    const openQuestionButton = findOpenQuestionButton();
    expect(openQuestionButton).toBeTruthy();

    await act(async () => {
      openQuestionButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const incrementalOption = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Incremental"));
    const customComment = container.querySelector("textarea[placeholder='Add your own comment']") as HTMLTextAreaElement | null;
    expect(incrementalOption).toBeTruthy();
    expect(customComment).toBeTruthy();

    await act(async () => {
      incrementalOption?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(incrementalOption?.getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(customComment, "Use a staged rollout with one extra audit pass.");
      customComment?.dispatchEvent(new Event("input", { bubbles: true }));
      customComment?.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const answerButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Answer");
    await act(async () => {
      answerButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockIssuesApi.answerQuestion).toHaveBeenCalledWith(question.id, {
      answer: "Use a staged rollout with one extra audit pass.",
    });

    await act(async () => {
      findOpenQuestionButton()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const dismissButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Dismiss");
    const escalateButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Escalate to approval");
    expect(dismissButton).toBeTruthy();
    expect(escalateButton).toBeTruthy();

    await act(async () => {
      dismissButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockIssuesApi.dismissQuestion).toHaveBeenCalledWith(question.id, {});

    await act(async () => {
      findOpenQuestionButton()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const reopenedEscalateButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Escalate to approval");
    await act(async () => {
      reopenedEscalateButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockIssuesApi.escalateQuestionApproval).toHaveBeenCalledWith(question.id, {});
  });

  it("renders answered options distinctly from freeform answers", async () => {
    const response = createContinuityResponse({
      issue: createIssue(),
      decisionQuestions: [
        createDecisionQuestion({
          id: "question-answered-option",
          status: "answered",
          answer: {
            selectedOptionKey: "incremental",
            answer: "Incremental",
            note: null,
          },
          answeredAt: new Date("2026-04-17T12:10:00.000Z"),
        }),
        createDecisionQuestion({
          id: "question-answered-comment",
          title: "Pick the fallback strategy",
          status: "answered",
          answer: {
            selectedOptionKey: null,
            answer: "Pause rollout until the test plan is expanded.",
            note: null,
          },
          answeredAt: new Date("2026-04-17T12:12:00.000Z"),
        }),
      ],
    });

    await renderPanel({ response });

    expect(container.textContent).toContain("Selected option: Incremental");
    expect(container.textContent).toContain("Answer: Pause rollout until the test plan is expanded.");
  });
});

import { describe, expect, it } from "vitest";
import {
  buildIssueDocumentTemplate,
  conferenceRoomKindSchema,
  connectionContractSchema,
  getReservedIssueDocumentDescriptor,
  getReservedProjectDocumentDescriptor,
  isIssueDocumentScaffoldBaseline,
  issueReservedDocumentKeySchema,
  parseIssueBranchReturnMarkdown,
  parseConnectionContractMarkdown,
  parseIssueBranchCharterMarkdown,
  parseIssueHandoffMarkdown,
  parseIssueProgressMarkdown,
  parseIssueReviewFindingsMarkdown,
  parsePacketEnvelopeMarkdown,
  packetEnvelopeSchema,
  projectReservedDocumentKeySchema,
} from "./index.js";

describe("operating model schemas", () => {
  it("normalizes connection contracts from frontmatter markdown", () => {
    const parsed = parseConnectionContractMarkdown([
      "---",
      "connectionContractKind: paperclip/connection-contract.v1",
      "connectionContract:",
      "  upstreamInputs:",
      '    - " issue assignments "',
      '    - "issue assignments"',
      "  downstreamOutputs:",
      '    - "heartbeat packets"',
      "  ownedArtifacts:",
      '    - "tasks/demo/docs/plan.md"',
      "  delegationRights:",
      '    - "delegate to direct reports"',
      "  reviewRights:",
      '    - "request QA review"',
      "  escalationPath:",
      '    - "team lead"',
      "  standingRooms:",
      '    - "project leadership"',
      "  scopeBoundaries:",
      '    - "company scoped only"',
      "  cadence:",
      '    workerUpdates: " every active work session "',
      '    executiveReview: " weekly "',
      "---",
      "",
      "Use the operating model.",
    ].join("\n"));

    expect(parsed).toEqual({
      connectionContractKind: "paperclip/connection-contract.v1",
      connectionContract: {
        upstreamInputs: ["issue assignments"],
        downstreamOutputs: ["heartbeat packets"],
        ownedArtifacts: ["tasks/demo/docs/plan.md"],
        delegationRights: ["delegate to direct reports"],
        reviewRights: ["request QA review"],
        escalationPath: ["team lead"],
        standingRooms: ["project leadership"],
        scopeBoundaries: ["company scoped only"],
        cadence: {
          workerUpdates: "every active work session",
          teamLeadSummary: null,
          projectLeadershipCheckIn: null,
          executiveReview: "weekly",
          incidentUpdate: null,
          consultingCloseout: null,
          milestoneReset: null,
        },
      },
      body: "Use the operating model.",
      frontmatter: expect.objectContaining({
        connectionContractKind: "paperclip/connection-contract.v1",
      }),
    });
  });

  it("parses every supported packet envelope kind", () => {
    const cases = [
      {
        markdown: [
          "---",
          "kind: paperclip/assignment.v1",
          'owner: "cto"',
          'objective: "Ship the rollout"',
          "definitionOfDone:",
          '  - "Docs updated"',
          "---",
          "",
          "Assignment note.",
        ].join("\n"),
        expected: {
          kind: "paperclip/assignment.v1",
          owner: "cto",
          objective: "Ship the rollout",
          definitionOfDone: ["Docs updated"],
        },
      },
      {
        markdown: [
          "---",
          "kind: paperclip/heartbeat.v1",
          "state: green",
          'progress: "Parser and UI landed"',
          "blockers:",
          '  - "Waiting on migration review"',
          "---",
          "",
          "Heartbeat note.",
        ].join("\n"),
        expected: {
          kind: "paperclip/heartbeat.v1",
          state: "green",
          progress: "Parser and UI landed",
          blockers: ["Waiting on migration review"],
        },
      },
      {
        markdown: [
          "---",
          "kind: paperclip/decision-request.v1",
          'decisionNeeded: "Approve the rollout order"',
          'recommendedOption: "Ship project docs first"',
          "---",
          "",
          "Decision context.",
        ].join("\n"),
        expected: {
          kind: "paperclip/decision-request.v1",
          decisionNeeded: "Approve the rollout order",
          recommendedOption: "Ship project docs first",
        },
      },
      {
        markdown: [
          "---",
          "kind: paperclip/review-request.v1",
          'reviewType: "qa"',
          'scope: "Packet parsing and rendering"',
          "---",
          "",
          "Review context.",
        ].join("\n"),
        expected: {
          kind: "paperclip/review-request.v1",
          reviewType: "qa",
          scope: "Packet parsing and rendering",
        },
      },
      {
        markdown: [
          "---",
          "kind: paperclip/escalation.v1",
          'problem: "Cannot proceed without migration approval"',
          'neededDecisionOrResource: "DB review"',
          "---",
          "",
          "Escalation context.",
        ].join("\n"),
        expected: {
          kind: "paperclip/escalation.v1",
          problem: "Cannot proceed without migration approval",
          neededDecisionOrResource: "DB review",
        },
      },
    ] as const;

    for (const testCase of cases) {
      const parsed = parsePacketEnvelopeMarkdown(testCase.markdown);
      expect(parsed?.envelope).toMatchObject(testCase.expected);
      expect(packetEnvelopeSchema.parse(parsed?.frontmatter)).toMatchObject(testCase.expected);
      expect(parsed?.body.length).toBeGreaterThan(0);
    }
  });

  it("falls back cleanly for malformed or unknown packet frontmatter", () => {
    expect(parsePacketEnvelopeMarkdown([
      "---",
      "kind: paperclip/unknown.v1",
      "---",
      "",
      "Plain markdown fallback.",
    ].join("\n"))).toBeNull();

    expect(parsePacketEnvelopeMarkdown([
      "---",
      "kind: paperclip/heartbeat.v1",
      "state:",
      '  - "green"',
      "---",
      "",
      "Still markdown.",
    ].join("\n"))).toBeNull();
  });

  it("keeps reserved document keys open-world", () => {
    expect(projectReservedDocumentKeySchema.parse("context")).toBe("context");
    expect(issueReservedDocumentKeySchema.parse("runbook")).toBe("runbook");
    expect(issueReservedDocumentKeySchema.parse("progress")).toBe("progress");
    expect(getReservedProjectDocumentDescriptor("context")?.label).toBe("Context");
    expect(getReservedIssueDocumentDescriptor("progress")?.label).toBe("Progress");
    expect(getReservedProjectDocumentDescriptor("notes")).toBeNull();
    expect(getReservedIssueDocumentDescriptor("scratchpad")).toBeNull();
  });

  it("parses typed continuity documents from frontmatter markdown", () => {
    const progress = parseIssueProgressMarkdown([
      "---",
      "kind: paperclip/issue-progress.v1",
      'summary: "Checkpoint summary"',
      'currentState: "Worktree is clean and tests are green"',
      'nextAction: "Open the PR"',
      "knownPitfalls:",
      '  - "Do not squash the sync commit"',
      "checkpoints:",
      "  - at: 2026-04-14T00:00:00Z",
      "    completed:",
      '      - "Merged upstream fixes"',
      '    currentState: "Ready for review"',
      '    nextAction: "Request review"',
      "---",
      "",
      "Freeform notes.",
    ].join("\n"));
    expect(progress?.document).toMatchObject({
      kind: "paperclip/issue-progress.v1",
      summary: "Checkpoint summary",
      currentState: "Worktree is clean and tests are green",
      nextAction: "Open the PR",
      checkpoints: [
        expect.objectContaining({
          currentState: "Ready for review",
          nextAction: "Request review",
        }),
      ],
    });

    const handoff = parseIssueHandoffMarkdown([
      "---",
      "kind: paperclip/issue-handoff.v1",
      'reasonCode: "reassignment"',
      "timestamp: 2026-04-14T00:00:00Z",
      'transferTarget: "agent:cto"',
      'exactNextAction: "Review the final checklist"',
      "---",
      "",
      "Hand off cleanly.",
    ].join("\n"));
    expect(handoff?.document).toMatchObject({
      kind: "paperclip/issue-handoff.v1",
      transferTarget: "agent:cto",
      exactNextAction: "Review the final checklist",
    });

    const branch = parseIssueBranchCharterMarkdown([
      "---",
      "kind: paperclip/issue-branch-charter.v1",
      'purpose: "Investigate the runtime regression"',
      'scope: "Heartbeat wakeups only"',
      'budget: "One branch issue and one review"',
      'expectedReturnArtifact: "Patch or reproduction notes"',
      "mergeCriteria:",
      '  - "Root cause is documented"',
      "---",
      "",
      "Branch notes.",
    ].join("\n"));
    expect(branch?.document).toMatchObject({
      kind: "paperclip/issue-branch-charter.v1",
      purpose: "Investigate the runtime regression",
      mergeCriteria: ["Root cause is documented"],
    });

    const reviewFindings = parseIssueReviewFindingsMarkdown([
      "---",
      "kind: paperclip/issue-review-findings.v1",
      'reviewer: "agent:qa"',
      'gateParticipant: "agent:qa"',
      'reviewStage: "review"',
      'outcome: "changes_requested"',
      'resolutionState: "open"',
      'ownerNextAction: "Address the failing edge case"',
      "findings:",
      "  - severity: medium",
      '    category: "correctness"',
      '    title: "Edge case missing"',
      '    detail: "The null path still fails."',
      '    requiredAction: "Add the missing guard."',
      "---",
      "",
      "Findings body.",
    ].join("\n"));
    expect(reviewFindings?.document).toMatchObject({
      kind: "paperclip/issue-review-findings.v1",
      outcome: "changes_requested",
      ownerNextAction: "Address the failing edge case",
      findings: [expect.objectContaining({ title: "Edge case missing", severity: "medium" })],
    });

    const branchReturn = parseIssueBranchReturnMarkdown([
      "---",
      "kind: paperclip/issue-branch-return.v1",
      'purposeScopeRecap: "Validate the branch fix"',
      'resultSummary: "Found the correct patch"',
      "proposedParentUpdates:",
      "  - documentKey: plan",
      "    action: append",
      '    summary: "Append the branch outcome"',
      '    content: "Add the accepted branch patch."',
      "mergeChecklist:",
      '  - "Confirm parent tests still pass"',
      "---",
      "",
      "Return body.",
    ].join("\n"));
    expect(branchReturn?.document).toMatchObject({
      kind: "paperclip/issue-branch-return.v1",
      resultSummary: "Found the correct patch",
      proposedParentUpdates: [expect.objectContaining({ documentKey: "plan", action: "append" })],
    });
  });

  it("builds default templates for continuity documents", () => {
    expect(buildIssueDocumentTemplate("spec")).toContain("## Goal");
    expect(buildIssueDocumentTemplate("progress")).toContain("paperclip/issue-progress.v1");
    expect(buildIssueDocumentTemplate("handoff")).toContain("paperclip/issue-handoff.v1");
    expect(buildIssueDocumentTemplate("branch-charter")).toContain("paperclip/issue-branch-charter.v1");
    expect(buildIssueDocumentTemplate("review-findings")).toContain("paperclip/issue-review-findings.v1");
    expect(buildIssueDocumentTemplate("branch-return")).toContain("paperclip/issue-branch-return.v1");
  });

  it("injects issue context into scaffolded continuity templates", () => {
    const spec = buildIssueDocumentTemplate("spec", {
      title: "Audit the architecture",
      description: "Check whether the shared-state execution model is enterprise ready.",
      tier: "normal",
    });
    const progress = buildIssueDocumentTemplate("progress", {
      title: "Audit the architecture",
      description: "Check whether the shared-state execution model is enterprise ready.",
    });

    expect(spec).toContain("Audit the architecture");
    expect(spec).toContain("enterprise ready");
    expect(spec).toContain("Continuity tier: `normal`");
    expect(progress).toContain("Issue created: Audit the architecture");
    expect(progress).toContain("enterprise ready");
  });

  it("accepts nullable room kinds through the shared enum schema", () => {
    expect(conferenceRoomKindSchema.parse("project_leadership")).toBe("project_leadership");
    expect(() => conferenceRoomKindSchema.parse("legacy_room")).toThrow();
  });

  it("normalizes direct connection contract schema input", () => {
    expect(connectionContractSchema.parse({
      upstreamInputs: ["board request", "board request", " "],
      downstreamOutputs: ["heartbeat packet"],
      ownedArtifacts: [],
      delegationRights: [],
      reviewRights: [],
      escalationPath: ["manager"],
      standingRooms: [],
      scopeBoundaries: ["company only"],
      cadence: {
        workerUpdates: "daily",
      },
    })).toEqual({
      upstreamInputs: ["board request"],
      downstreamOutputs: ["heartbeat packet"],
      ownedArtifacts: [],
      delegationRights: [],
      reviewRights: [],
      escalationPath: ["manager"],
      standingRooms: [],
      scopeBoundaries: ["company only"],
      cadence: {
        workerUpdates: "daily",
        teamLeadSummary: null,
        projectLeadershipCheckIn: null,
        executiveReview: null,
        incidentUpdate: null,
        consultingCloseout: null,
        milestoneReset: null,
      },
    });
  });
});

describe("isIssueDocumentScaffoldBaseline", () => {
  const context = { title: "Reduce scaffold freeze", description: "Make first-write painless", tier: "normal" as const };

  it("returns true when the body equals the generated template exactly", () => {
    const template = buildIssueDocumentTemplate("spec", context);
    expect(template).not.toBeNull();
    expect(isIssueDocumentScaffoldBaseline("spec", template!, context)).toBe(true);
  });

  it("returns true when the body only differs by trailing whitespace or line endings", () => {
    const template = buildIssueDocumentTemplate("plan", context);
    expect(template).not.toBeNull();
    const noisy = template!.replace(/\n/g, "\r\n") + "  \n\n";
    expect(isIssueDocumentScaffoldBaseline("plan", noisy, context)).toBe(true);
  });

  it("returns false when the body has user edits beyond the scaffold", () => {
    const template = buildIssueDocumentTemplate("test-plan", context);
    expect(template).not.toBeNull();
    const edited = `${template}\n\n- New coverage added by the continuity owner`;
    expect(isIssueDocumentScaffoldBaseline("test-plan", edited, context)).toBe(false);
  });

  it("returns false when the body was generated for a different issue context", () => {
    const otherTemplate = buildIssueDocumentTemplate("spec", {
      title: "Different work",
      description: "Unrelated description",
      tier: "normal",
    });
    expect(otherTemplate).not.toBeNull();
    expect(isIssueDocumentScaffoldBaseline("spec", otherTemplate!, context)).toBe(false);
  });

  it("returns false for unsupported document keys", () => {
    expect(isIssueDocumentScaffoldBaseline("unknown-key", "any body", context)).toBe(false);
  });
});

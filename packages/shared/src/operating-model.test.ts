import { describe, expect, it } from "vitest";
import {
  conferenceRoomKindSchema,
  connectionContractSchema,
  getReservedIssueDocumentDescriptor,
  getReservedProjectDocumentDescriptor,
  issueReservedDocumentKeySchema,
  parseConnectionContractMarkdown,
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
    expect(issueReservedDocumentKeySchema.parse("plan")).toBe("plan");
    expect(getReservedProjectDocumentDescriptor("context")?.label).toBe("Context");
    expect(getReservedIssueDocumentDescriptor("plan")?.label).toBe("Plan");
    expect(getReservedProjectDocumentDescriptor("notes")).toBeNull();
    expect(getReservedIssueDocumentDescriptor("scratchpad")).toBeNull();
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

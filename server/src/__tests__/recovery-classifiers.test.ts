import { describe, expect, it } from "vitest";
import {
  RECOVERY_KEY_PREFIXES,
  RECOVERY_ORIGIN_KINDS,
  buildIssueGraphLivenessIncidentKey,
  buildIssueGraphLivenessLeafKey,
  classifyIssueGraphLiveness,
  isStrandedIssueRecoveryOriginKind,
  parseIssueGraphLivenessIncidentKey,
} from "../services/recovery/index.js";

const companyId = "company-1";
const sourceIssueId = "issue-1";
const blockerIssueId = "blocker-1";
const ownerAgentId = "agent-1";
const managerAgentId = "manager-1";

describe("recovery classifiers", () => {
  it("classifies blocked issue graphs with unassigned blocker leaves", () => {
    const findings = classifyIssueGraphLiveness({
      issues: [
        {
          id: sourceIssueId,
          companyId,
          identifier: "PAP-1",
          title: "Blocked feature",
          status: "blocked",
          assigneeAgentId: ownerAgentId,
          assigneeUserId: null,
          createdByAgentId: null,
          createdByUserId: null,
          executionState: null,
        },
        {
          id: blockerIssueId,
          companyId,
          identifier: "PAP-2",
          title: "Missing unblock owner",
          status: "todo",
          assigneeAgentId: null,
          assigneeUserId: null,
          createdByAgentId: null,
          createdByUserId: null,
          executionState: null,
        },
      ],
      relations: [{ companyId, blockerIssueId, blockedIssueId: sourceIssueId }],
      agents: [
        {
          id: ownerAgentId,
          companyId,
          name: "Builder",
          role: "engineer",
          status: "idle",
          reportsTo: managerAgentId,
        },
        {
          id: managerAgentId,
          companyId,
          name: "CTO",
          role: "cto",
          status: "idle",
          reportsTo: null,
        },
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      issueId: sourceIssueId,
      recoveryIssueId: blockerIssueId,
      state: "blocked_by_unassigned_issue",
      recommendedOwnerAgentId: managerAgentId,
    });
  });

  it("keeps recovery origin and dedupe key contracts stable", () => {
    expect(RECOVERY_ORIGIN_KINDS).toMatchObject({
      issueGraphLivenessEscalation: "harness_liveness_escalation",
      issueProductivityReview: "issue_productivity_review",
      strandedIssueRecovery: "stranded_issue_recovery",
      staleActiveRunEvaluation: "stale_active_run_evaluation",
    });
    expect(RECOVERY_KEY_PREFIXES.issueGraphLivenessIncident).toBe("harness_liveness");
    expect(RECOVERY_KEY_PREFIXES.issueGraphLivenessLeaf).toBe("harness_liveness_leaf");

    const incidentKey = buildIssueGraphLivenessIncidentKey({
      companyId,
      issueId: sourceIssueId,
      state: "blocked_by_unassigned_issue",
      blockerIssueId,
    });
    expect(incidentKey).toBe("harness_liveness:company-1:issue-1:blocked_by_unassigned_issue:blocker-1");
    expect(parseIssueGraphLivenessIncidentKey(incidentKey)).toEqual({
      companyId,
      issueId: sourceIssueId,
      state: "blocked_by_unassigned_issue",
      leafIssueId: blockerIssueId,
    });
    expect(buildIssueGraphLivenessLeafKey({
      companyId,
      state: "blocked_by_unassigned_issue",
      leafIssueId: blockerIssueId,
    })).toBe("harness_liveness_leaf:company-1:blocked_by_unassigned_issue:blocker-1");
    expect(isStrandedIssueRecoveryOriginKind("stranded_issue_recovery")).toBe(true);
    expect(isStrandedIssueRecoveryOriginKind("manual")).toBe(false);
  });
});

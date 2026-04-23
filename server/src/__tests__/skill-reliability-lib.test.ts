import { describe, expect, it } from "vitest";
import { parseIssueProgressMarkdown } from "@paperclipai/shared";
import {
  buildSkillHardeningScaffolds,
  summarizeHardeningDocumentProgress,
} from "../services/skill-reliability-lib.ts";

describe("skill reliability hardening scaffolds", () => {
  it("includes a valid progress document so repaired hardening issues pass normal continuity setup", () => {
    const scaffolds = buildSkillHardeningScaffolds({
      title: "Skill reliability: qa-only",
      skillName: "qa-only",
      skillKey: "global/claude/7388ede6ad/qa-only",
      failureFingerprint: "fingerprint-1",
      reliabilityFindingCodes: ["missing-reliability-metadata"],
    });

    expect(scaffolds.spec).toContain("## Failure Source");
    expect(scaffolds.spec).toContain("Treat upstream/global skill source directories as read-only");
    expect(scaffolds.plan).toContain("## Skill Hardening Steps");
    expect(scaffolds.plan).toContain("do not edit global source catalog files directly");
    expect(scaffolds.plan).toContain("## Source Edit Policy");
    expect(scaffolds.testPlan).toContain("## Promptfoo");
    expect(parseIssueProgressMarkdown(scaffolds.progress)).not.toBeNull();

    expect(
      summarizeHardeningDocumentProgress({
        documentsByKey: {
          spec: scaffolds.spec,
          plan: scaffolds.plan,
          progress: scaffolds.progress,
          "test-plan": scaffolds.testPlan,
        },
        issueTitle: "Skill reliability: qa-only",
        issueDescription: "Reliability audit follow-up for qa-only.",
      }).missingCount,
    ).toBe(0);
  });
});

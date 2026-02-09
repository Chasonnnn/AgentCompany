import { describe, expect, test } from "vitest";
import { newArtifactMarkdown, validateMarkdownArtifact } from "../src/artifacts/markdown.js";

describe("artifact markdown", () => {
  test("new artifact validates", () => {
    const md = newArtifactMarkdown({
      type: "proposal",
      title: "Payments Proposal",
      visibility: "managers",
      produced_by: "agent_mgr_payments",
      run_id: "run_123",
      context_pack_id: "ctx_123"
    });
    const res = validateMarkdownArtifact(md);
    expect(res.ok).toBe(true);
  });

  test("validation fails when required heading missing", () => {
    const md = newArtifactMarkdown({
      type: "milestone_report",
      title: "Milestone 1",
      visibility: "team",
      produced_by: "agent_worker_1",
      run_id: "run_123",
      context_pack_id: "ctx_123"
    }).replace("## Evidence", "## NotEvidence");
    const res = validateMarkdownArtifact(md);
    expect(res.ok).toBe(false);
  });
});


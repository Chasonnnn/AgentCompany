import { describe, expect, test } from "vitest";
import { deriveProjectNameFromRepoPath, deriveRepoIdFromRepoPath } from "../desktop-react/src/services/queries.js";

describe("desktop create-project repo folder helpers", () => {
  test("derives project name from repo folder path", () => {
    expect(deriveProjectNameFromRepoPath("/Users/chason/AgentCompany/")).toBe("AgentCompany");
    expect(deriveProjectNameFromRepoPath("C:\\dev\\billing-service")).toBe("billing-service");
  });

  test("derives stable repo id independent of trailing slash", () => {
    const a = deriveRepoIdFromRepoPath("/Users/chason/AgentCompany");
    const b = deriveRepoIdFromRepoPath("/Users/chason/AgentCompany/");
    expect(a).toBe(b);
    expect(a.startsWith("repo_agentcompany_")).toBe(true);
  });
});

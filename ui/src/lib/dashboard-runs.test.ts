import { describe, expect, it } from "vitest";
import { uniqueRunsByAgent } from "./dashboard-runs";

describe("uniqueRunsByAgent", () => {
  it("keeps only the first run for each agent while preserving order", () => {
    expect(
      uniqueRunsByAgent([
        { id: "run-1", agentId: "agent-1", label: "live" },
        { id: "run-2", agentId: "agent-2", label: "recent" },
        { id: "run-3", agentId: "agent-1", label: "older duplicate" },
        { id: "run-4", agentId: "agent-3", label: "recent" },
        { id: "run-5", agentId: "agent-2", label: "older duplicate" },
      ]),
    ).toEqual([
      { id: "run-1", agentId: "agent-1", label: "live" },
      { id: "run-2", agentId: "agent-2", label: "recent" },
      { id: "run-4", agentId: "agent-3", label: "recent" },
    ]);
  });
});

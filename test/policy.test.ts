import { describe, expect, test } from "vitest";
import { evaluatePolicy } from "../src/policy/policy.js";

describe("policy", () => {
  test("worker cannot read other team's team-visible resource", () => {
    const decision = evaluatePolicy(
      { actor_id: "agent_worker_a", role: "worker", team_id: "team_a" },
      "read",
      { resource_id: "art_x", visibility: "team", team_id: "team_b" }
    );
    expect(decision.allowed).toBe(false);
  });

  test("manager can read other team's team-visible resource", () => {
    const decision = evaluatePolicy(
      { actor_id: "agent_mgr_a", role: "manager", team_id: "team_a" },
      "read",
      { resource_id: "art_x", visibility: "team", team_id: "team_b" }
    );
    expect(decision.allowed).toBe(true);
  });

  test("worker cannot approve", () => {
    const decision = evaluatePolicy(
      { actor_id: "agent_worker_a", role: "worker", team_id: "team_a" },
      "approve",
      { resource_id: "rev_x", visibility: "managers" }
    );
    expect(decision.allowed).toBe(false);
  });
});


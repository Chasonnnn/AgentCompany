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

  test("manager cannot approve memory delta", () => {
    const decision = evaluatePolicy(
      { actor_id: "agent_mgr_a", role: "manager", team_id: "team_a" },
      "approve",
      { resource_id: "art_mem", visibility: "managers", kind: "memory_delta" }
    );
    expect(decision.allowed).toBe(false);
  });

  test("director can approve memory delta", () => {
    const decision = evaluatePolicy(
      { actor_id: "agent_dir_a", role: "director", team_id: "team_a" },
      "approve",
      { resource_id: "art_mem", visibility: "managers", kind: "memory_delta" }
    );
    expect(decision.allowed).toBe(true);
  });

  test("manager can still approve non-memory approvals", () => {
    const milestone = evaluatePolicy(
      { actor_id: "agent_mgr_a", role: "manager", team_id: "team_a" },
      "approve",
      { resource_id: "art_ms", visibility: "team", kind: "milestone_report", team_id: "team_b" }
    );
    expect(milestone.allowed).toBe(true);

    const heartbeat = evaluatePolicy(
      { actor_id: "agent_mgr_a", role: "manager", team_id: "team_a" },
      "approve",
      { resource_id: "art_hb", visibility: "managers", kind: "heartbeat_action" }
    );
    expect(heartbeat.allowed).toBe(true);
  });

  test("manager cannot read private_agent artifacts they did not produce", () => {
    const decision = evaluatePolicy(
      { actor_id: "agent_mgr_a", role: "manager", team_id: "team_a" },
      "read",
      {
        resource_id: "art_private",
        visibility: "private_agent",
        producing_actor_id: "agent_worker_b"
      }
    );
    expect(decision.allowed).toBe(false);
  });

  test("human can read private_agent artifacts regardless of owner", () => {
    const decision = evaluatePolicy(
      { actor_id: "human", role: "human" },
      "read",
      {
        resource_id: "art_private",
        visibility: "private_agent",
        producing_actor_id: "agent_worker_b"
      }
    );
    expect(decision.allowed).toBe(true);
  });

  test("manager cannot compose restricted context", () => {
    const decision = evaluatePolicy(
      { actor_id: "agent_mgr_a", role: "manager", team_id: "team_a" },
      "compose_context",
      {
        resource_id: "art_mem_restricted",
        visibility: "managers",
        sensitivity: "restricted"
      }
    );
    expect(decision.allowed).toBe(false);
  });

  test("director can compose restricted context", () => {
    const decision = evaluatePolicy(
      { actor_id: "agent_dir_a", role: "director", team_id: "team_a" },
      "compose_context",
      {
        resource_id: "art_mem_restricted",
        visibility: "managers",
        sensitivity: "restricted"
      }
    );
    expect(decision.allowed).toBe(true);
  });
});

export type ActorRole = "human" | "ceo" | "director" | "manager" | "worker";

export type Visibility = "private_agent" | "team" | "managers" | "org";

export type PolicyAction = "read" | "approve";

export type PolicyActor = {
  actor_id: string;
  role: ActorRole;
  team_id?: string;
};

export type Resource = {
  resource_id: string;
  visibility: Visibility;
  team_id?: string;
  producing_actor_id?: string;
  kind?: string;
};

export type PolicyDecision =
  | {
      allowed: true;
      rule_id: string;
      reason: string;
    }
  | {
      allowed: false;
      rule_id: string;
      reason: string;
    };

const MANAGER_ROLES: ReadonlySet<ActorRole> = new Set([
  "human",
  "ceo",
  "director",
  "manager"
]);

export function evaluatePolicy(
  actor: PolicyActor,
  action: PolicyAction,
  resource: Resource
): PolicyDecision {
  // v0: approvals are restricted to managers+ by default.
  if (action === "approve" && !MANAGER_ROLES.has(actor.role)) {
    return { allowed: false, rule_id: "approve.role", reason: "role_not_allowed" };
  }

  switch (resource.visibility) {
    case "org":
      return { allowed: true, rule_id: "vis.org", reason: "org_visible" };
    case "managers":
      return MANAGER_ROLES.has(actor.role)
        ? { allowed: true, rule_id: "vis.managers", reason: "manager_visible" }
        : { allowed: false, rule_id: "vis.managers", reason: "role_not_allowed" };
    case "team": {
      if (MANAGER_ROLES.has(actor.role)) {
        return { allowed: true, rule_id: "vis.team.manager_override", reason: "manager_override" };
      }
      if (actor.team_id && resource.team_id && actor.team_id === resource.team_id) {
        return { allowed: true, rule_id: "vis.team.same_team", reason: "same_team" };
      }
      return { allowed: false, rule_id: "vis.team.mismatch", reason: "team_mismatch" };
    }
    case "private_agent": {
      if (actor.role === "human") {
        return { allowed: true, rule_id: "vis.private.human", reason: "human_override" };
      }
      if (resource.producing_actor_id && resource.producing_actor_id === actor.actor_id) {
        return { allowed: true, rule_id: "vis.private.owner", reason: "owner" };
      }
      return { allowed: false, rule_id: "vis.private.owner", reason: "not_owner" };
    }
    default: {
      const _exhaustive: never = resource.visibility;
      return _exhaustive;
    }
  }
}


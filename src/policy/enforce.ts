import path from "node:path";
import { nowIso } from "../core/time.js";
import { appendEventJsonl, newEnvelope } from "../runtime/events.js";
import {
  evaluatePolicy,
  type ActorRole,
  type PolicyAction,
  type PolicyDecision,
  type Resource
} from "./policy.js";

export type EnforcePolicyArgs = {
  workspace_dir: string;
  project_id: string;
  run_id?: string;
  actor_id: string;
  actor_role: ActorRole;
  actor_team_id?: string;
  action: PolicyAction;
  resource: Resource;
};

async function appendPolicyDeniedEvent(args: {
  workspace_dir: string;
  project_id: string;
  run_id: string;
  actor_id: string;
  action: PolicyAction;
  resource: Resource;
  policy: Exclude<PolicyDecision, { allowed: true }>;
}): Promise<void> {
  const eventsAbs = path.join(
    args.workspace_dir,
    "work/projects",
    args.project_id,
    "runs",
    args.run_id,
    "events.jsonl"
  );
  try {
    await appendEventJsonl(
      eventsAbs,
      newEnvelope({
        schema_version: 1,
        ts_wallclock: nowIso(),
        run_id: args.run_id,
        session_ref: `local_${args.run_id}`,
        actor: args.actor_id,
        visibility: "managers",
        type: "policy.denied",
        payload: {
          action: args.action,
          resource_id: args.resource.resource_id,
          resource_kind: args.resource.kind ?? null,
          resource_visibility: args.resource.visibility,
          policy: args.policy
        }
      })
    );
  } catch {
    // Best-effort: policy evaluation must still fail hard even if logging fails.
  }
}

export async function enforcePolicy(args: EnforcePolicyArgs): Promise<PolicyDecision> {
  const decision = evaluatePolicy(
    { actor_id: args.actor_id, role: args.actor_role, team_id: args.actor_team_id },
    args.action,
    args.resource
  );
  if (decision.allowed) return decision;

  if (args.run_id) {
    await appendPolicyDeniedEvent({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id,
      run_id: args.run_id,
      actor_id: args.actor_id,
      action: args.action,
      resource: args.resource,
      policy: decision
    });
  }
  const actionLabel = args.action === "approve" ? "approval" : args.action;
  throw new Error(`Policy denied ${actionLabel}: ${decision.rule_id} (${decision.reason})`);
}


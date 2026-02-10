import fs from "node:fs/promises";
import path from "node:path";
import { applyPatch } from "diff";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { writeFileAtomic } from "../store/fs.js";
import { readYamlFile, writeYamlFile } from "../store/yaml.js";
import { type ActorRole } from "../policy/policy.js";
import { enforcePolicy } from "../policy/enforce.js";
import { newEnvelope, appendEventJsonl } from "../runtime/events.js";
import { parseMemoryDeltaMarkdown } from "./memory_delta.js";

export type ApproveMemoryDeltaArgs = {
  workspace_dir: string;
  project_id: string;
  artifact_id: string;
  actor_id: string;
  actor_role: ActorRole;
  actor_team_id?: string;
  notes?: string;
};

export type ApproveMemoryDeltaResult = {
  review_id: string;
  decision: "approved";
};

function ensureWorkspaceRelative(p: string): void {
  if (path.isAbsolute(p)) {
    throw new Error(`Path must be workspace-relative, not absolute: ${p}`);
  }
  const normalized = path.normalize(p);
  if (normalized.startsWith("..")) {
    throw new Error(`Path must not escape the workspace: ${p}`);
  }
}

export async function approveMemoryDelta(
  args: ApproveMemoryDeltaArgs
): Promise<ApproveMemoryDeltaResult> {
  const artifactRel = path.join(
    "work/projects",
    args.project_id,
    "artifacts",
    `${args.artifact_id}.md`
  );
  const artifactAbs = path.join(args.workspace_dir, artifactRel);

  const md = await fs.readFile(artifactAbs, { encoding: "utf8" });
  const parsed = parseMemoryDeltaMarkdown(md);
  if (!parsed.ok) throw new Error(parsed.error);
  if (parsed.frontmatter.project_id !== args.project_id) {
    throw new Error(
      `Memory delta project_id mismatch (expected ${args.project_id}, got ${parsed.frontmatter.project_id})`
    );
  }

  ensureWorkspaceRelative(parsed.frontmatter.target_file);
  ensureWorkspaceRelative(parsed.frontmatter.patch_file);

  const policy = await enforcePolicy({
    workspace_dir: args.workspace_dir,
    project_id: args.project_id,
    run_id: parsed.frontmatter.run_id,
    actor_id: args.actor_id,
    actor_role: args.actor_role,
    actor_team_id: args.actor_team_id,
    action: "approve",
    resource: {
      resource_id: parsed.frontmatter.id,
      visibility: parsed.frontmatter.visibility,
      kind: "memory_delta"
    }
  });

  const targetAbs = path.join(args.workspace_dir, parsed.frontmatter.target_file);
  const patchAbs = path.join(args.workspace_dir, parsed.frontmatter.patch_file);

  const before = await fs.readFile(targetAbs, { encoding: "utf8" });
  const patchText = await fs.readFile(patchAbs, { encoding: "utf8" });

  const after = applyPatch(before, patchText);
  if (after === false) throw new Error("Patch did not apply cleanly to target file");

  await writeFileAtomic(targetAbs, after);

  const reviewId = newId("rev");
  const createdAt = nowIso();
  const reviewRel = path.join("inbox/reviews", `${reviewId}.yaml`);
  const reviewAbs = path.join(args.workspace_dir, reviewRel);

  await writeYamlFile(reviewAbs, {
    schema_version: 1,
    type: "review",
    id: reviewId,
    created_at: createdAt,
    actor_id: args.actor_id,
    actor_role: args.actor_role,
    decision: "approved",
    subject: {
      kind: "memory_delta",
      artifact_id: parsed.frontmatter.id,
      project_id: parsed.frontmatter.project_id,
      target_file: parsed.frontmatter.target_file,
      patch_file: parsed.frontmatter.patch_file
    },
    policy,
    notes: args.notes ?? ""
  });

  // Append to run events if the run exists in this project.
  const runId = parsed.frontmatter.run_id;
  const eventsAbs = path.join(
    args.workspace_dir,
    "work/projects",
    args.project_id,
    "runs",
    runId,
    "events.jsonl"
  );
  try {
    await fs.access(eventsAbs);
    await appendEventJsonl(
      eventsAbs,
      newEnvelope({
        schema_version: 1,
        ts_wallclock: createdAt,
        run_id: runId,
        session_ref: `local_${runId}`,
        actor: args.actor_id,
        visibility: "managers",
        type: "approval.decided",
        payload: {
          review_id: reviewId,
          decision: "approved",
          subject_kind: "memory_delta",
          artifact_id: parsed.frontmatter.id,
          target_file: parsed.frontmatter.target_file,
          patch_file: parsed.frontmatter.patch_file,
          policy
        }
      })
    );
  } catch {
    // If the run doesn't exist, approvals are still recorded as review artifacts.
  }

  // Best-effort: validate updated workspace state doesn't violate schema.
  // Review schema validation will be added when inbox objects are indexed.
  void (await readYamlFile(reviewAbs));

  return { review_id: reviewId, decision: "approved" };
}

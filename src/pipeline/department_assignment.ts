import fs from "node:fs/promises";
import path from "node:path";
import { createTaskFile, addTaskMilestone } from "../work/tasks.js";
import { parseFrontMatter } from "../artifacts/frontmatter.js";
import { AgentYaml } from "../schemas/agent.js";
import { ReviewYaml } from "../schemas/review.js";
import { listTeams } from "../org/teams_list.js";
import { readYamlFile } from "../store/yaml.js";
import { ensureDir, writeFileAtomic } from "../store/fs.js";
import { nowIso } from "../core/time.js";
import { parseHeartbeatActionProposalMarkdown } from "../heartbeat/action_proposal.js";

export type AssignDepartmentTasksArgs = {
  workspace_dir: string;
  project_id: string;
  department_key: string;
  director_agent_id: string;
  worker_agent_ids: string[];
  approved_executive_plan_artifact_id: string;
};

export type DepartmentAssignmentDenied = {
  worker_agent_id: string;
  reason: string;
  expected_team_id?: string;
  actual_team_id?: string;
};

export type AssignDepartmentTasksResult = {
  project_id: string;
  department_key: string;
  director_agent_id: string;
  executive_plan_artifact_id: string;
  created_task_ids: string[];
  created_milestone_ids: string[];
  assignment_map: Record<string, string>;
  denied_assignments: DepartmentAssignmentDenied[];
  audit_log_relpath: string;
};

async function readAgent(workspaceDir: string, agentId: string): Promise<AgentYaml> {
  const abs = path.join(workspaceDir, "org", "agents", agentId, "agent.yaml");
  return AgentYaml.parse(await readYamlFile(abs));
}

async function validateExecutivePlanArtifact(args: {
  workspace_dir: string;
  project_id: string;
  artifact_id: string;
}): Promise<void> {
  const abs = path.join(
    args.workspace_dir,
    "work",
    "projects",
    args.project_id,
    "artifacts",
    `${args.artifact_id}.md`
  );
  const markdown = await fs.readFile(abs, { encoding: "utf8" });
  const parsed = parseFrontMatter(markdown);
  if (!parsed.ok) throw new Error(`Invalid executive plan artifact: ${parsed.error}`);
  const type = (parsed.frontmatter as Record<string, unknown>).type;
  if (type !== "executive_plan") {
    throw new Error(`approved_executive_plan_artifact_id must reference an executive_plan artifact`);
  }
}

function proposalLinksExecutivePlan(args: {
  project_id: string;
  executive_plan_artifact_id: string;
  proposed_action: Record<string, unknown>;
  rationale?: string;
}): boolean {
  const linkedByRationale = `executive_plan_artifact_id=${args.executive_plan_artifact_id}`;
  const rationaleCandidates = [args.rationale];
  if (typeof args.proposed_action.rationale === "string") {
    rationaleCandidates.push(args.proposed_action.rationale);
  }
  for (const rationale of rationaleCandidates) {
    if (typeof rationale === "string" && rationale.includes(linkedByRationale)) return true;
  }

  const idempotencyKeys: string[] = [];
  if (typeof args.proposed_action.idempotency_key === "string") {
    idempotencyKeys.push(args.proposed_action.idempotency_key);
  }
  if (
    args.proposed_action.kind === "create_approval_item" &&
    args.proposed_action.proposed_action &&
    typeof args.proposed_action.proposed_action === "object"
  ) {
    const nested = args.proposed_action.proposed_action as Record<string, unknown>;
    if (typeof nested.idempotency_key === "string") idempotencyKeys.push(nested.idempotency_key);
  }

  const strictToken = `:${args.project_id}:${args.executive_plan_artifact_id}`;
  return idempotencyKeys.some(
    (key) => key.includes(strictToken) || key.endsWith(`:${args.executive_plan_artifact_id}`) || key.includes(args.executive_plan_artifact_id)
  );
}

async function assertExecutivePlanApprovedByCeo(args: {
  workspace_dir: string;
  project_id: string;
  executive_plan_artifact_id: string;
}): Promise<void> {
  const reviewsDir = path.join(args.workspace_dir, "inbox", "reviews");
  let files: string[] = [];
  try {
    files = (await fs.readdir(reviewsDir)).filter((f) => f.endsWith(".yaml"));
  } catch {
    files = [];
  }

  for (const file of files) {
    let reviewDoc: unknown;
    try {
      reviewDoc = await readYamlFile(path.join(reviewsDir, file));
    } catch {
      continue;
    }
    const parsed = ReviewYaml.safeParse(reviewDoc);
    if (!parsed.success) continue;
    const review = parsed.data;
    if (review.decision !== "approved") continue;
    if (review.subject.kind !== "heartbeat_action") continue;
    if (review.subject.project_id !== args.project_id) continue;
    if (review.actor_role !== "ceo" && review.actor_role !== "human") continue;

    const proposalAbs = path.join(
      args.workspace_dir,
      "work",
      "projects",
      args.project_id,
      "artifacts",
      `${review.subject.artifact_id}.md`
    );
    let proposalMarkdown = "";
    try {
      proposalMarkdown = await fs.readFile(proposalAbs, { encoding: "utf8" });
    } catch {
      continue;
    }
    const proposal = parseHeartbeatActionProposalMarkdown(proposalMarkdown);
    if (!proposal.ok) continue;
    if (proposal.frontmatter.project_id !== args.project_id) continue;
    if (
      proposalLinksExecutivePlan({
        project_id: args.project_id,
        executive_plan_artifact_id: args.executive_plan_artifact_id,
        proposed_action: proposal.frontmatter.proposed_action as Record<string, unknown>,
        rationale: proposal.frontmatter.rationale
      })
    ) {
      return;
    }
  }

  throw new Error(`CEO approval required for executive plan ${args.executive_plan_artifact_id}`);
}

export async function assignDepartmentTasks(
  args: AssignDepartmentTasksArgs
): Promise<AssignDepartmentTasksResult> {
  const workspaceDir = args.workspace_dir.trim();
  const projectId = args.project_id.trim();
  const departmentKey = args.department_key.trim();
  const directorAgentId = args.director_agent_id.trim();
  const executivePlanArtifactId = args.approved_executive_plan_artifact_id.trim();
  if (!workspaceDir) throw new Error("workspace_dir is required");
  if (!projectId) throw new Error("project_id is required");
  if (!departmentKey) throw new Error("department_key is required");
  if (!directorAgentId) throw new Error("director_agent_id is required");
  if (!executivePlanArtifactId) throw new Error("approved_executive_plan_artifact_id is required");
  if (args.worker_agent_ids.length === 0) throw new Error("worker_agent_ids must be non-empty");

  await validateExecutivePlanArtifact({
    workspace_dir: workspaceDir,
    project_id: projectId,
    artifact_id: executivePlanArtifactId
  });
  await assertExecutivePlanApprovedByCeo({
    workspace_dir: workspaceDir,
    project_id: projectId,
    executive_plan_artifact_id: executivePlanArtifactId
  });

  const [director, teams] = await Promise.all([
    readAgent(workspaceDir, directorAgentId),
    listTeams({ workspace_dir: workspaceDir })
  ]);
  if (director.role !== "director") {
    throw new Error(`director_agent_id must reference a director role`);
  }
  if (!director.team_id) {
    throw new Error(`director agent must belong to a team`);
  }
  const team = teams.find((t) => t.team_id === director.team_id);
  if (!team) {
    throw new Error(`director team not found: ${director.team_id}`);
  }
  if ((team.department_key ?? "").toLowerCase() !== departmentKey.toLowerCase()) {
    throw new Error(
      `department_key mismatch: director team department is ${team.department_key ?? "(none)"}`
    );
  }

  const createdTaskIds: string[] = [];
  const createdMilestoneIds: string[] = [];
  const assignmentMap: Record<string, string> = {};
  const deniedAssignments: DepartmentAssignmentDenied[] = [];
  const auditEvents: Array<Record<string, unknown>> = [];

  for (const workerAgentIdRaw of args.worker_agent_ids) {
    const workerAgentId = workerAgentIdRaw.trim();
    if (!workerAgentId) continue;
    const worker = await readAgent(workspaceDir, workerAgentId);
    if (worker.role !== "worker") {
      deniedAssignments.push({
        worker_agent_id: workerAgentId,
        reason: "not_worker_role",
        expected_team_id: director.team_id,
        actual_team_id: worker.team_id
      });
      auditEvents.push({
        ts: nowIso(),
        event: "assignment_denied",
        reason: "not_worker_role",
        director_agent_id: directorAgentId,
        worker_agent_id: workerAgentId,
        expected_team_id: director.team_id,
        actual_team_id: worker.team_id
      });
      continue;
    }
    if (!worker.team_id || worker.team_id !== director.team_id) {
      deniedAssignments.push({
        worker_agent_id: workerAgentId,
        reason: "cross_team_assignment_denied",
        expected_team_id: director.team_id,
        actual_team_id: worker.team_id
      });
      auditEvents.push({
        ts: nowIso(),
        event: "assignment_denied",
        reason: "cross_team_assignment_denied",
        director_agent_id: directorAgentId,
        worker_agent_id: workerAgentId,
        expected_team_id: director.team_id,
        actual_team_id: worker.team_id
      });
      continue;
    }

    const workerTask = await createTaskFile({
      workspace_dir: workspaceDir,
      project_id: projectId,
      title: `${team.department_label ?? team.name}: Execution Task for ${worker.name}`,
      visibility: "team",
      team_id: director.team_id,
      assignee_agent_id: workerAgentId
    });
    const milestone = await addTaskMilestone({
      workspace_dir: workspaceDir,
      project_id: projectId,
      task_id: workerTask.task_id,
      milestone: {
        title: "Implement assigned department scope",
        kind: "coding",
        status: "ready",
        acceptance_criteria: [
          `Executive plan reference: ${executivePlanArtifactId}`,
          "Director review confirms deliverables are complete",
          "Evidence artifacts attached for implementation"
        ]
      }
    });
    createdTaskIds.push(workerTask.task_id);
    createdMilestoneIds.push(milestone.milestone_id);
    assignmentMap[workerAgentId] = workerTask.task_id;
    auditEvents.push({
      ts: nowIso(),
      event: "assignment_created",
      director_agent_id: directorAgentId,
      worker_agent_id: workerAgentId,
      team_id: director.team_id,
      task_id: workerTask.task_id,
      milestone_id: milestone.milestone_id
    });
  }

  const logsDir = path.join(workspaceDir, "work", "projects", projectId, "logs");
  await ensureDir(logsDir);
  const auditName = `department_assignment_${Date.now()}.jsonl`;
  const auditAbs = path.join(logsDir, auditName);
  await writeFileAtomic(
    auditAbs,
    auditEvents.map((event) => JSON.stringify(event)).join("\n") + (auditEvents.length ? "\n" : "")
  );

  return {
    project_id: projectId,
    department_key: departmentKey,
    director_agent_id: directorAgentId,
    executive_plan_artifact_id: executivePlanArtifactId,
    created_task_ids: createdTaskIds,
    created_milestone_ids: createdMilestoneIds,
    assignment_map: assignmentMap,
    denied_assignments: deniedAssignments,
    audit_log_relpath: path.join("work", "projects", projectId, "logs", auditName)
  };
}

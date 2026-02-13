import fs from "node:fs/promises";
import path from "node:path";
import { nowIso } from "../core/time.js";
import { parseFrontMatter } from "../artifacts/frontmatter.js";
import { TaskFrontMatter } from "../work/task_markdown.js";
import { pathExists, writeFileAtomic } from "../store/fs.js";

type Assignment = {
  project_id: string;
  task_id: string;
  created_at: string;
  task_relpath: string;
  scope_repo_id?: string;
  scope_workdir_rel?: string;
  scope_paths: string[];
};

export type RefreshAgentContextIndexArgs = {
  workspace_dir: string;
  agent_id: string;
  project_id?: string;
  max_tasks?: number;
  max_scope_paths?: number;
};

export type RefreshAgentContextIndexResult = {
  agent_id: string;
  context_index_relpath: string;
  assignment_count: number;
  reference_count: number;
  updated: boolean;
  generated_at: string;
  project_id?: string;
};

async function listDirectories(absDir: string): Promise<string[]> {
  try {
    const ents = await fs.readdir(absDir, { withFileTypes: true });
    return ents
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

async function listTaskFiles(absDir: string): Promise<string[]> {
  try {
    const ents = await fs.readdir(absDir, { withFileTypes: true });
    return ents
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

async function collectAssignments(args: RefreshAgentContextIndexArgs): Promise<Assignment[]> {
  const projectIds = args.project_id
    ? [args.project_id]
    : await listDirectories(path.join(args.workspace_dir, "work/projects"));
  const all: Assignment[] = [];
  for (const projectId of projectIds) {
    const tasksDir = path.join(args.workspace_dir, "work/projects", projectId, "tasks");
    const files = await listTaskFiles(tasksDir);
    for (const file of files) {
      const rel = path.join("work/projects", projectId, "tasks", file);
      const abs = path.join(args.workspace_dir, rel);
      let md = "";
      try {
        md = await fs.readFile(abs, { encoding: "utf8" });
      } catch {
        continue;
      }
      const parsed = parseFrontMatter(md);
      if (!parsed.ok) continue;
      const fmParsed = TaskFrontMatter.safeParse(parsed.frontmatter);
      if (!fmParsed.success) continue;
      const fm = fmParsed.data;
      if (fm.assignee_agent_id !== args.agent_id) continue;
      all.push({
        project_id: projectId,
        task_id: fm.id,
        created_at: fm.created_at,
        task_relpath: rel,
        scope_repo_id: fm.scope?.repo_id,
        scope_workdir_rel: fm.scope?.workdir_rel,
        scope_paths: fm.scope?.paths ?? []
      });
    }
  }

  all.sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    return a.task_id.localeCompare(b.task_id);
  });

  const maxTasks = Math.max(1, Math.min(args.max_tasks ?? 20, 200));
  return all.slice(0, maxTasks);
}

function appendUnique(lines: string[], seen: Set<string>, line: string): void {
  if (seen.has(line)) return;
  seen.add(line);
  lines.push(line);
}

function buildContextLines(args: {
  agent_id: string;
  assignments: Assignment[];
  include_mistakes_log: boolean;
  max_scope_paths: number;
}): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();

  appendUnique(lines, seen, `- company_contract: \`company/company.yaml\``);
  appendUnique(lines, seen, `- org_visibility_policy: \`company/policy.yaml\``);
  appendUnique(lines, seen, `- agent_profile: \`org/agents/${args.agent_id}/agent.yaml\``);
  appendUnique(lines, seen, `- agent_journal: \`org/agents/${args.agent_id}/journal.md\``);
  if (args.include_mistakes_log) {
    appendUnique(lines, seen, `- mistakes_log: \`org/agents/${args.agent_id}/mistakes.yaml\``);
  }

  if (args.assignments.length === 0) {
    appendUnique(lines, seen, "- no_assigned_tasks: true");
    return lines;
  }

  const scopeLimit = Math.max(1, Math.min(args.max_scope_paths, 500));
  let scopeCount = 0;
  for (const a of args.assignments) {
    appendUnique(lines, seen, `- assigned_task: \`${a.task_relpath}\``);
    appendUnique(lines, seen, `- project_memory: \`work/projects/${a.project_id}/memory.md\``);
    if (a.scope_repo_id) {
      appendUnique(lines, seen, `- task_scope_repo_id: \`${a.scope_repo_id}\` (task: \`${a.task_id}\`)`);
    }
    if (a.scope_workdir_rel) {
      appendUnique(
        lines,
        seen,
        `- task_scope_workdir: \`${a.scope_workdir_rel}\` (task: \`${a.task_id}\`)`
      );
    }
    for (const p of a.scope_paths) {
      if (scopeCount >= scopeLimit) break;
      appendUnique(lines, seen, `- task_scope_path: \`${p}\` (task: \`${a.task_id}\`)`);
      scopeCount += 1;
    }
    if (scopeCount >= scopeLimit) break;
  }

  if (scopeCount >= scopeLimit) {
    appendUnique(lines, seen, `- task_scope_paths_truncated: true (max_scope_paths=${scopeLimit})`);
  }

  return lines;
}

function renderContextIndexMarkdown(args: {
  agent_id: string;
  lines: string[];
}): string {
  const out: string[] = [
    `# Context Index - ${args.agent_id}`,
    "",
    "## References"
  ];
  if (args.lines.length) {
    out.push(...args.lines);
  } else {
    out.push("- no_assigned_tasks: true");
  }
  return `${out.join("\n")}\n`;
}

export async function refreshAgentContextIndex(
  args: RefreshAgentContextIndexArgs
): Promise<RefreshAgentContextIndexResult> {
  if (!args.workspace_dir.trim()) throw new Error("workspace_dir is required");
  if (!args.agent_id.trim()) throw new Error("agent_id is required");

  const agentYaml = path.join(args.workspace_dir, "org/agents", args.agent_id, "agent.yaml");
  if (!(await pathExists(agentYaml))) {
    throw new Error(`Agent not found: ${args.agent_id}`);
  }

  const contextRel = path.join("org/agents", args.agent_id, "context_index.md");
  const contextAbs = path.join(args.workspace_dir, contextRel);
  const mistakesAbs = path.join(args.workspace_dir, "org/agents", args.agent_id, "mistakes.yaml");

  const assignments = await collectAssignments(args);
  const lines = buildContextLines({
    agent_id: args.agent_id,
    assignments,
    include_mistakes_log: await pathExists(mistakesAbs),
    max_scope_paths: args.max_scope_paths ?? 40
  });

  const generatedAt = nowIso();
  const rendered = renderContextIndexMarkdown({
    agent_id: args.agent_id,
    lines
  });

  let existing = "";
  try {
    existing = await fs.readFile(contextAbs, { encoding: "utf8" });
  } catch {
    existing = "";
  }

  const changed = existing !== rendered;
  if (changed) {
    await writeFileAtomic(contextAbs, rendered);
  }

  return {
    agent_id: args.agent_id,
    context_index_relpath: contextRel,
    assignment_count: assignments.length,
    reference_count: lines.length,
    updated: changed,
    generated_at: generatedAt,
    project_id: args.project_id
  };
}

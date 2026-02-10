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
  agents_md_relpath: string;
  assignment_count: number;
  reference_count: number;
  updated: boolean;
  generated_at: string;
  project_id?: string;
};

const CONTEXT_HEADING = "## Relevant Context Index";
const CONTEXT_MARKER = "<!-- managed: context-index -->";

function baseAgentGuidance(agentId: string): string {
  return [
    `# AGENTS.md - ${agentId}`,
    "",
    "## Operating Rules",
    "- Follow the assigned task contract and milestone acceptance criteria.",
    "- Produce required evidence artifacts for coding milestones (patch/commit + tests).",
    "- Report blockers early with concrete evidence.",
    "",
    "## Recurring Mistakes To Avoid",
    "<!-- managed: recurring-mistakes -->",
    "",
    CONTEXT_HEADING,
    CONTEXT_MARKER,
    ""
  ].join("\n");
}

async function ensureGuidanceFile(absPath: string, agentId: string): Promise<string> {
  if (await pathExists(absPath)) {
    return fs.readFile(absPath, { encoding: "utf8" });
  }
  const initial = baseAgentGuidance(agentId);
  await writeFileAtomic(absPath, initial);
  return initial;
}

async function listDirectories(absPath: string): Promise<string[]> {
  try {
    const ents = await fs.readdir(absPath, { withFileTypes: true });
    return ents
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

async function listTaskFiles(absPath: string): Promise<string[]> {
  try {
    const ents = await fs.readdir(absPath, { withFileTypes: true });
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

  appendUnique(lines, seen, `- company_contract: \`company.yaml\``);
  appendUnique(lines, seen, `- org_visibility_policy: \`org/policy.yaml\``);
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

function normalizeNewline(s: string): string {
  return s.endsWith("\n") ? s : `${s}\n`;
}

function findSectionEnd(markdown: string, start: number): number {
  const rest = markdown.slice(start);
  const nextHeadingRel = rest.search(/^##\s.+$/m);
  if (nextHeadingRel === -1) return markdown.length;
  return start + nextHeadingRel;
}

function upsertContextSection(markdown: string, lines: string[]): { updated: string; changed: boolean } {
  const withNl = normalizeNewline(markdown);
  const markerIdx = withNl.indexOf(CONTEXT_MARKER);
  const sectionBody = `${CONTEXT_MARKER}\n${lines.join("\n")}${lines.length ? "\n" : ""}`;

  if (markerIdx >= 0) {
    const markerLineStart = withNl.lastIndexOf("\n", markerIdx);
    const markerStart = markerLineStart === -1 ? 0 : markerLineStart + 1;
    const markerLineEnd = withNl.indexOf("\n", markerIdx);
    const afterMarkerLine = markerLineEnd === -1 ? withNl.length : markerLineEnd + 1;
    const end = findSectionEnd(withNl, afterMarkerLine);
    const updated = `${withNl.slice(0, markerStart)}${sectionBody}${withNl.slice(end)}`;
    return { updated, changed: updated !== withNl };
  }

  const headingIdx = withNl.indexOf(CONTEXT_HEADING);
  if (headingIdx >= 0) {
    const headingLineEnd = withNl.indexOf("\n", headingIdx);
    const afterHeading = headingLineEnd === -1 ? withNl.length : headingLineEnd + 1;
    const end = findSectionEnd(withNl, afterHeading);
    const updated = `${withNl.slice(0, afterHeading)}${sectionBody}${withNl.slice(end)}`;
    return { updated, changed: updated !== withNl };
  }

  const prefix = withNl.trimEnd();
  const updated = `${prefix}\n\n${CONTEXT_HEADING}\n${sectionBody}`;
  return { updated: normalizeNewline(updated), changed: true };
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

  const guidanceRel = path.join("org/agents", args.agent_id, "AGENTS.md");
  const guidanceAbs = path.join(args.workspace_dir, guidanceRel);
  const mistakesAbs = path.join(args.workspace_dir, "org/agents", args.agent_id, "mistakes.yaml");

  const assignments = await collectAssignments(args);
  const lines = buildContextLines({
    agent_id: args.agent_id,
    assignments,
    include_mistakes_log: await pathExists(mistakesAbs),
    max_scope_paths: args.max_scope_paths ?? 40
  });

  const existing = await ensureGuidanceFile(guidanceAbs, args.agent_id);
  const replaced = upsertContextSection(existing, lines);
  if (replaced.changed) {
    await writeFileAtomic(guidanceAbs, replaced.updated);
  }

  return {
    agent_id: args.agent_id,
    agents_md_relpath: guidanceRel,
    assignment_count: assignments.length,
    reference_count: lines.length,
    updated: replaced.changed,
    generated_at: nowIso(),
    project_id: args.project_id
  };
}

#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { initWorkspace } from "./workspace/init.js";
import { validateWorkspace } from "./workspace/validate.js";
import { ArtifactType, newArtifactMarkdown, validateMarkdownArtifact } from "./artifacts/markdown.js";
import { writeFileAtomic } from "./store/fs.js";
import { Visibility } from "./schemas/common.js";
import { createTeam } from "./org/teams.js";
import { createAgent } from "./org/agents.js";
import { createProject } from "./work/projects.js";
import { AgentRole } from "./schemas/agent.js";
import { createRun } from "./runtime/run.js";
import { executeCommandRun } from "./runtime/execute_command.js";
import { setProviderBin, setRepoRoot } from "./machine/machine.js";
import { createTaskFile, addTaskMilestone } from "./work/tasks.js";
import { MilestoneKind, MilestoneStatus, validateTaskMarkdown } from "./work/task_markdown.js";
import { proposeMemoryDelta } from "./memory/propose_memory_delta.js";
import { approveMemoryDelta } from "./memory/approve_memory_delta.js";
import { listRuns, readEventsJsonl } from "./runtime/run_queries.js";
import { createMilestoneReportFile } from "./milestones/report_files.js";
import { approveMilestone } from "./milestones/approve_milestone.js";

class UserError extends Error {
  override name = "UserError";
}

function reportError(e: unknown): void {
  const err = e instanceof Error ? e : new Error(String(e));
  if (err instanceof UserError) {
    process.stderr.write(`ERROR: ${err.message}\n`);
    return;
  }
  process.stderr.write(`ERROR: ${err.message}\n`);
  if (process.env.AC_DEBUG === "1" && err.stack) {
    process.stderr.write(`${err.stack}\n`);
  }
}

async function runAction(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    reportError(e);
    process.exitCode = 1;
  }
}

const program = new Command();

program.name("ac").description("AgentCompany CLI").version("0.0.0");

program
  .command("workspace:init")
  .description("Initialize a new Company Workspace folder")
  .argument("<dir>", "Workspace root directory")
  .option("--name <name>", "Company name", "AgentCompany")
  .option("--force", "Initialize even if the directory is non-empty", false)
  .action(async (dir: string, opts: { name: string; force: boolean }) => {
    await runAction(async () => {
      await initWorkspace({ root_dir: dir, company_name: opts.name, force: opts.force });
      process.stdout.write(`Initialized workspace at ${dir}\n`);
    });
  });

program
  .command("workspace:validate")
  .description("Validate an existing Company Workspace folder")
  .argument("<dir>", "Workspace root directory")
  .action(async (dir: string) => {
    await runAction(async () => {
      const res = await validateWorkspace(dir);
      if (res.ok) {
        process.stdout.write("OK\n");
        return;
      }
      process.stderr.write("VALIDATION FAILED\n");
      for (const i of res.issues) process.stderr.write(`- ${i.message}\n`);
      process.exitCode = 2;
    });
  });

program
  .command("team:new")
  .description("Create a new team in a workspace")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--name <name>", "Team name", "")
  .action(async (workspaceDir: string, opts: { name: string }) => {
    await runAction(async () => {
      if (!opts.name.trim()) throw new UserError("--name is required");
      const { team_id } = await createTeam({ workspace_dir: workspaceDir, name: opts.name });
      process.stdout.write(`${team_id}\n`);
    });
  });

program
  .command("agent:new")
  .description("Create a new agent in a workspace")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--name <name>", "Agent name", "")
  .option("--role <role>", "Role (ceo|director|manager|worker)", "")
  .option("--provider <provider>", "Provider driver name (e.g., codex, claude_code)", "")
  .option("--team <team_id>", "Team id (optional)", undefined)
  .action(
    async (
      workspaceDir: string,
      opts: { name: string; role: string; provider: string; team?: string }
    ) => {
      await runAction(async () => {
        if (!opts.name.trim()) throw new UserError("--name is required");
        if (!opts.role.trim()) throw new UserError("--role is required");
        if (!opts.provider.trim()) throw new UserError("--provider is required");
        const roleParsed = AgentRole.safeParse(opts.role);
        if (!roleParsed.success) {
          throw new UserError(
            `Invalid role "${opts.role}". Valid: ${AgentRole.options.join(", ")}`
          );
        }
        const { agent_id } = await createAgent({
          workspace_dir: workspaceDir,
          name: opts.name,
          role: roleParsed.data,
          provider: opts.provider,
          team_id: opts.team
        });
        process.stdout.write(`${agent_id}\n`);
      });
    }
  );

program
  .command("project:new")
  .description("Create a new project in a workspace")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--name <name>", "Project name", "")
  .action(async (workspaceDir: string, opts: { name: string }) => {
    await runAction(async () => {
      if (!opts.name.trim()) throw new UserError("--name is required");
      const { project_id } = await createProject({ workspace_dir: workspaceDir, name: opts.name });
      process.stdout.write(`${project_id}\n`);
    });
  });

program
  .command("run:new")
  .description("Create a new run folder (run.yaml + events.jsonl + context pack skeleton)")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--project <project_id>", "Project id", "")
  .option("--agent <agent_id>", "Agent id", "")
  .option("--provider <provider>", "Provider name", "")
  .action(
    async (
      workspaceDir: string,
      opts: { project: string; agent: string; provider: string }
    ) => {
      await runAction(async () => {
        if (!opts.project.trim()) throw new UserError("--project is required");
        if (!opts.agent.trim()) throw new UserError("--agent is required");
        if (!opts.provider.trim()) throw new UserError("--provider is required");
        const { run_id, context_pack_id } = await createRun({
          workspace_dir: workspaceDir,
          project_id: opts.project,
          agent_id: opts.agent,
          provider: opts.provider
        });
        process.stdout.write(JSON.stringify({ run_id, context_pack_id }) + "\n");
      });
    }
  );

program
  .command("run:execute")
  .description("Execute a command for an existing run (streams provider.raw to events.jsonl)")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--project <project_id>", "Project id", "")
  .option("--run <run_id>", "Run id", "")
  .option("--argv <argv...>", "Command argv", [])
  .option("--repo <repo_id>", "Repo id (resolves via .local/machine.yaml)", undefined)
  .option("--subdir <workdir_rel>", "Workdir relative to repo root", undefined)
  .action(
    async (
      workspaceDir: string,
      opts: {
        project: string;
        run: string;
        argv: string[];
        repo?: string;
        subdir?: string;
      }
    ) => {
      await runAction(async () => {
        if (!opts.project.trim()) throw new UserError("--project is required");
        if (!opts.run.trim()) throw new UserError("--run is required");
        if (!opts.argv.length) throw new UserError("--argv is required (use --argv cmd arg1 arg2)");
        const res = await executeCommandRun({
          workspace_dir: workspaceDir,
          project_id: opts.project,
          run_id: opts.run,
          argv: opts.argv,
          repo_id: opts.repo,
          workdir_rel: opts.subdir
        });
        process.stdout.write(JSON.stringify(res) + "\n");
      });
    }
  );

program
  .command("run:list")
  .description("List runs (best-effort) for a project or entire workspace")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--project <project_id>", "Project id (optional)", undefined)
  .action(async (workspaceDir: string, opts: { project?: string }) => {
    await runAction(async () => {
      const runs = await listRuns({ workspace_dir: workspaceDir, project_id: opts.project });
      process.stdout.write(JSON.stringify(runs, null, 2) + "\n");
    });
  });

program
  .command("run:replay")
  .description("Replay a run timeline from events.jsonl")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--project <project_id>", "Project id", "")
  .option("--run <run_id>", "Run id", "")
  .option("--tail <n>", "Show only the last N events", (v) => parseInt(v, 10), undefined)
  .action(
    async (
      workspaceDir: string,
      opts: { project: string; run: string; tail?: number }
    ) => {
      await runAction(async () => {
        if (!opts.project.trim()) throw new UserError("--project is required");
        if (!opts.run.trim()) throw new UserError("--run is required");
        const eventsPath = path.join(
          workspaceDir,
          "work/projects",
          opts.project,
          "runs",
          opts.run,
          "events.jsonl"
        );
        const lines = await readEventsJsonl(eventsPath);
        const slice = opts.tail && opts.tail > 0 ? lines.slice(-opts.tail) : lines;
        for (const l of slice) {
          if (!l.ok) {
            process.stdout.write(`[parse_error] ${l.error}: ${l.raw}\n`);
            continue;
          }
          const ev = l.event;
          const ts = String(ev.ts_wallclock ?? "");
          const type = String(ev.type ?? "");
          const actor = String(ev.actor ?? "");
          process.stdout.write(`${ts} ${type} actor=${actor}\n`);
        }
      });
    }
  );

program
  .command("machine:set-repo")
  .description("Set a repo_id -> absolute path mapping in .local/machine.yaml")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--repo <repo_id>", "Repo id", "")
  .option("--path <abs_path>", "Absolute repo path", "")
  .action(async (workspaceDir: string, opts: { repo: string; path: string }) => {
    await runAction(async () => {
      if (!opts.repo.trim()) throw new UserError("--repo is required");
      if (!opts.path.trim()) throw new UserError("--path is required");
      await setRepoRoot(workspaceDir, opts.repo, opts.path);
      process.stdout.write("OK\n");
    });
  });

program
  .command("machine:set-provider-bin")
  .description("Set a provider -> absolute CLI path mapping in .local/machine.yaml")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--provider <provider>", "Provider name (e.g., codex, claude_code)", "")
  .option("--path <abs_path>", "Absolute CLI path", "")
  .action(async (workspaceDir: string, opts: { provider: string; path: string }) => {
    await runAction(async () => {
      if (!opts.provider.trim()) throw new UserError("--provider is required");
      if (!opts.path.trim()) throw new UserError("--path is required");
      await setProviderBin(workspaceDir, opts.provider, opts.path);
      process.stdout.write("OK\n");
    });
  });

program
  .command("task:new")
  .description("Create a new task contract file in a project")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--project <project_id>", "Project id", "")
  .option("--title <title>", "Task title", "")
  .option("--visibility <visibility>", "Visibility (private_agent|team|managers|org)", "team")
  .option("--team <team_id>", "Team id (optional)", undefined)
  .option("--assignee <agent_id>", "Assignee agent id (optional)", undefined)
  .action(
    async (
      workspaceDir: string,
      opts: {
        project: string;
        title: string;
        visibility: string;
        team?: string;
        assignee?: string;
      }
    ) => {
      await runAction(async () => {
        if (!opts.project.trim()) throw new UserError("--project is required");
        if (!opts.title.trim()) throw new UserError("--title is required");
        const visParsed = Visibility.safeParse(opts.visibility);
        if (!visParsed.success) {
          throw new UserError(
            `Invalid visibility "${opts.visibility}". Valid: ${Visibility.options.join(", ")}`
          );
        }
        const { task_id } = await createTaskFile({
          workspace_dir: workspaceDir,
          project_id: opts.project,
          title: opts.title,
          visibility: visParsed.data,
          team_id: opts.team,
          assignee_agent_id: opts.assignee
        });
        process.stdout.write(`${task_id}\n`);
      });
    }
  );

program
  .command("task:add-milestone")
  .description("Append a milestone to an existing task")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--project <project_id>", "Project id", "")
  .option("--task <task_id>", "Task id", "")
  .option("--title <title>", "Milestone title", "")
  .option("--kind <kind>", "Milestone kind (coding|research|planning)", "")
  .option("--status <status>", "Milestone status (draft|ready|in_progress|blocked|done)", "draft")
  .option("--accept <criteria...>", "Acceptance criteria strings", [])
  .action(
    async (
      workspaceDir: string,
      opts: {
        project: string;
        task: string;
        title: string;
        kind: string;
        status: string;
        accept: string[];
      }
    ) => {
      await runAction(async () => {
        if (!opts.project.trim()) throw new UserError("--project is required");
        if (!opts.task.trim()) throw new UserError("--task is required");
        if (!opts.title.trim()) throw new UserError("--title is required");
        if (!opts.kind.trim()) throw new UserError("--kind is required");
        const kindParsed = MilestoneKind.safeParse(opts.kind);
        if (!kindParsed.success) {
          throw new UserError(
            `Invalid kind "${opts.kind}". Valid: ${MilestoneKind.options.join(", ")}`
          );
        }
        const statusParsed = MilestoneStatus.safeParse(opts.status);
        if (!statusParsed.success) {
          throw new UserError(
            `Invalid status "${opts.status}". Valid: ${MilestoneStatus.options.join(", ")}`
          );
        }
        const { milestone_id } = await addTaskMilestone({
          workspace_dir: workspaceDir,
          project_id: opts.project,
          task_id: opts.task,
          milestone: {
            title: opts.title,
            kind: kindParsed.data,
            status: statusParsed.data,
            acceptance_criteria: opts.accept
          }
        });
        process.stdout.write(`${milestone_id}\n`);
      });
    }
  );

program
  .command("task:validate")
  .description("Validate a single task markdown file (front matter + required sections)")
  .argument("<file>", "Task markdown file path")
  .action(async (file: string) => {
    await runAction(async () => {
      const md = await fs.readFile(file, { encoding: "utf8" });
      const res = validateTaskMarkdown(md);
      if (res.ok) {
        process.stdout.write("OK\n");
        return;
      }
      process.stderr.write("VALIDATION FAILED\n");
      for (const i of res.issues) process.stderr.write(`- ${i.message}\n`);
      process.exitCode = 2;
    });
  });

program
  .command("memory:delta")
  .description("Propose a curated memory delta (writes memory_delta artifact + unified diff patch)")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--project <project_id>", "Project id", "")
  .option("--title <title>", "Delta title", "")
  .option("--target <relpath>", "Target memory file (workspace-relative)", undefined)
  .option("--under <heading>", "Heading to insert under (exact match)", "")
  .option("--insert <line...>", "Lines to insert under the heading", [])
  .option("--visibility <visibility>", "Visibility (private_agent|team|managers|org)", "managers")
  .option("--by <producer>", "Produced by (agent_id|human)", "human")
  .option("--run <run_id>", "Run id", "run_manual")
  .option("--ctx <context_pack_id>", "Context pack id", "ctx_manual")
  .option("--evidence <artifact_id...>", "Evidence artifact ids", [])
  .action(
    async (
      workspaceDir: string,
      opts: {
        project: string;
        title: string;
        target?: string;
        under: string;
        insert: string[];
        visibility: string;
        by: string;
        run: string;
        ctx: string;
        evidence: string[];
      }
    ) => {
      await runAction(async () => {
        if (!opts.project.trim()) throw new UserError("--project is required");
        if (!opts.title.trim()) throw new UserError("--title is required");
        if (!opts.under.trim()) throw new UserError("--under is required");
        if (!opts.insert.length) throw new UserError("--insert is required (one or more lines)");
        const visParsed = Visibility.safeParse(opts.visibility);
        if (!visParsed.success) {
          throw new UserError(
            `Invalid visibility "${opts.visibility}". Valid: ${Visibility.options.join(", ")}`
          );
        }
        const res = await proposeMemoryDelta({
          workspace_dir: workspaceDir,
          project_id: opts.project,
          title: opts.title,
          target_file: opts.target,
          under_heading: opts.under,
          insert_lines: opts.insert,
          visibility: visParsed.data,
          produced_by: opts.by,
          run_id: opts.run,
          context_pack_id: opts.ctx,
          evidence: opts.evidence.length ? opts.evidence : undefined
        });
        process.stdout.write(JSON.stringify(res) + "\n");
      });
    }
  );

program
  .command("memory:approve")
  .description("Approve and apply a memory delta patch; writes a review record and appends an approval event")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--project <project_id>", "Project id", "")
  .option("--artifact <artifact_id>", "Memory delta artifact id (art_...)", "")
  .option("--actor <actor_id>", "Actor id (human or agent id)", "human")
  .option("--role <role>", "Actor role (human|ceo|director|manager|worker)", "human")
  .option("--notes <notes>", "Approval notes", "")
  .action(
    async (
      workspaceDir: string,
      opts: { project: string; artifact: string; actor: string; role: string; notes: string }
    ) => {
      await runAction(async () => {
        if (!opts.project.trim()) throw new UserError("--project is required");
        if (!opts.artifact.trim()) throw new UserError("--artifact is required");
        const role = opts.role as any;
        if (!["human", "ceo", "director", "manager", "worker"].includes(role)) {
          throw new UserError('Invalid --role. Valid: human, ceo, director, manager, worker');
        }
        const res = await approveMemoryDelta({
          workspace_dir: workspaceDir,
          project_id: opts.project,
          artifact_id: opts.artifact,
          actor_id: opts.actor,
          actor_role: role,
          notes: opts.notes
        });
        process.stdout.write(JSON.stringify(res) + "\n");
      });
    }
  );

program
  .command("milestone:report:new")
  .description("Create a milestone_report artifact file under the project artifacts folder")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--project <project_id>", "Project id", "")
  .option("--task <task_id>", "Task id", "")
  .option("--milestone <milestone_id>", "Milestone id", "")
  .option("--title <title>", "Report title", "")
  .option("--visibility <visibility>", "Visibility (private_agent|team|managers|org)", "team")
  .option("--by <producer>", "Produced by (agent_id|human)", "human")
  .option("--run <run_id>", "Run id", "run_manual")
  .option("--ctx <context_pack_id>", "Context pack id", "ctx_manual")
  .option("--evidence <artifact_id...>", "Evidence artifact ids", [])
  .option("--tests <artifact_id...>", "Tests artifact ids", [])
  .action(
    async (
      workspaceDir: string,
      opts: {
        project: string;
        task: string;
        milestone: string;
        title: string;
        visibility: string;
        by: string;
        run: string;
        ctx: string;
        evidence: string[];
        tests: string[];
      }
    ) => {
      await runAction(async () => {
        if (!opts.project.trim()) throw new UserError("--project is required");
        if (!opts.task.trim()) throw new UserError("--task is required");
        if (!opts.milestone.trim()) throw new UserError("--milestone is required");
        if (!opts.title.trim()) throw new UserError("--title is required");
        const visParsed = Visibility.safeParse(opts.visibility);
        if (!visParsed.success) {
          throw new UserError(
            `Invalid visibility "${opts.visibility}". Valid: ${Visibility.options.join(", ")}`
          );
        }
        const res = await createMilestoneReportFile(workspaceDir, {
          title: opts.title,
          visibility: visParsed.data,
          produced_by: opts.by,
          run_id: opts.run,
          context_pack_id: opts.ctx,
          project_id: opts.project,
          task_id: opts.task,
          milestone_id: opts.milestone,
          evidence_artifacts: opts.evidence,
          tests_artifacts: opts.tests.length ? opts.tests : undefined
        });
        process.stdout.write(JSON.stringify(res) + "\n");
      });
    }
  );

program
  .command("milestone:approve")
  .description("Approve a milestone report; updates task milestone status and writes a review record")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--project <project_id>", "Project id", "")
  .option("--task <task_id>", "Task id", "")
  .option("--milestone <milestone_id>", "Milestone id", "")
  .option("--report <artifact_id>", "milestone_report artifact id (art_...)", "")
  .option("--actor <actor_id>", "Actor id (human or agent id)", "human")
  .option("--role <role>", "Actor role (human|ceo|director|manager|worker)", "human")
  .option("--notes <notes>", "Approval notes", "")
  .action(
    async (
      workspaceDir: string,
      opts: {
        project: string;
        task: string;
        milestone: string;
        report: string;
        actor: string;
        role: string;
        notes: string;
      }
    ) => {
      await runAction(async () => {
        if (!opts.project.trim()) throw new UserError("--project is required");
        if (!opts.task.trim()) throw new UserError("--task is required");
        if (!opts.milestone.trim()) throw new UserError("--milestone is required");
        if (!opts.report.trim()) throw new UserError("--report is required");
        const role = opts.role as any;
        if (!["human", "ceo", "director", "manager", "worker"].includes(role)) {
          throw new UserError('Invalid --role. Valid: human, ceo, director, manager, worker');
        }
        const res = await approveMilestone({
          workspace_dir: workspaceDir,
          project_id: opts.project,
          task_id: opts.task,
          milestone_id: opts.milestone,
          report_artifact_id: opts.report,
          actor_id: opts.actor,
          actor_role: role,
          notes: opts.notes
        });
        process.stdout.write(JSON.stringify(res) + "\n");
      });
    }
  );

program
  .command("artifact:new")
  .description("Create a new artifact markdown file from a canonical template")
  .argument("<type>", "Artifact type")
  .argument("<file>", "Output file path")
  .option("--title <title>", "Artifact title", "Untitled")
  .option("--visibility <visibility>", "Visibility (private_agent|team|managers|org)", "team")
  .option("--by <producer>", "Produced by (agent_id|human)", "human")
  .option("--run <run_id>", "Run id", "run_manual")
  .option("--ctx <context_pack_id>", "Context pack id", "ctx_manual")
  .option("--force", "Overwrite the output file if it exists", false)
  .action(
    async (
      type: string,
      file: string,
      opts: {
        title: string;
        visibility: string;
        by: string;
        run: string;
        ctx: string;
        force: boolean;
      }
    ) => {
      await runAction(async () => {
        const typeParsed = ArtifactType.safeParse(type);
        if (!typeParsed.success) {
          throw new UserError(
            `Invalid type "${type}". Valid types: ${ArtifactType.options.join(", ")}`
          );
        }
        const visParsed = Visibility.safeParse(opts.visibility);
        if (!visParsed.success) {
          throw new UserError(
            `Invalid visibility "${opts.visibility}". Valid: ${Visibility.options.join(", ")}`
          );
        }

        if (!opts.force) {
          let exists = false;
          try {
            await fs.access(file);
            exists = true;
          } catch (e) {
            const err = e as NodeJS.ErrnoException;
            if (err?.code !== "ENOENT") throw e;
          }
          if (exists) {
            throw new UserError(`Refusing to overwrite existing file: ${file} (use --force)`);
          }
        }

        const md = newArtifactMarkdown({
          type: typeParsed.data,
          title: opts.title,
          visibility: visParsed.data,
          produced_by: opts.by,
          run_id: opts.run,
          context_pack_id: opts.ctx
        });
        await writeFileAtomic(file, md);
        process.stdout.write(`Wrote ${file}\n`);
      });
    }
  );

program
  .command("artifact:validate")
  .description("Validate a single artifact markdown file (front matter + required sections)")
  .argument("<file>", "Artifact markdown file path")
  .action(async (file: string) => {
    await runAction(async () => {
      const md = await fs.readFile(file, { encoding: "utf8" });
      const res = validateMarkdownArtifact(md);
      if (res.ok) {
        process.stdout.write("OK\n");
        return;
      }
      process.stderr.write("VALIDATION FAILED\n");
      for (const i of res.issues) process.stderr.write(`- ${i.message}\n`);
      process.exitCode = 2;
    });
  });

await program.parseAsync(process.argv);

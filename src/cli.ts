#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { initWorkspace } from "./workspace/init.js";
import { validateWorkspace } from "./workspace/validate.js";
import { doctorWorkspace } from "./workspace/doctor.js";
import { createWorkspaceDiagnosticsBundle } from "./workspace/diagnostics.js";
import { migrateWorkspace } from "./workspace/migrate.js";
import { exportWorkspace, importWorkspace } from "./workspace/export_import.js";
import { ArtifactType, newArtifactMarkdown, validateMarkdownArtifact } from "./artifacts/markdown.js";
import { readArtifactWithPolicy } from "./artifacts/read_artifact.js";
import { writeFileAtomic } from "./store/fs.js";
import { Visibility } from "./schemas/common.js";
import { createTeam } from "./org/teams.js";
import { createAgent } from "./org/agents.js";
import { createProject } from "./work/projects.js";
import { AgentRole } from "./schemas/agent.js";
import { createRun } from "./runtime/run.js";
import { executeCommandRun } from "./runtime/execute_command.js";
import { cleanupWorktrees } from "./runtime/worktree_cleanup.js";
import { setProviderBin, setRepoRoot } from "./machine/machine.js";
import { createTaskFile, addTaskMilestone } from "./work/tasks.js";
import { MilestoneKind, MilestoneStatus, validateTaskMarkdown } from "./work/task_markdown.js";
import { proposeMemoryDelta } from "./memory/propose_memory_delta.js";
import { approveMemoryDelta } from "./memory/approve_memory_delta.js";
import { listRuns } from "./runtime/run_queries.js";
import { replayRun } from "./runtime/replay.js";
import { createMilestoneReportFile } from "./milestones/report_files.js";
import { approveMilestone } from "./milestones/approve_milestone.js";
import { createSharePack } from "./share/share_pack.js";
import { replaySharePack } from "./share/replay.js";
import { createHelpRequestFile } from "./help/help_request_files.js";
import { validateHelpRequestMarkdown } from "./help/help_request.js";
import { demoInit } from "./demo/demo_init.js";
import { scaffoldProjectIntake } from "./pipeline/intake_scaffold.js";
import { fillArtifactWithProvider } from "./pipeline/artifact_fill.js";
import { runPlanningPipeline } from "./pipeline/plan_run.js";
import { recordAgentMistake } from "./eval/mistake_loop.js";
import { refreshAgentContextIndex } from "./eval/agent_context_index.js";
import { resolveInboxItem } from "./inbox/resolve.js";
import { resolveInboxAndBuildUiSnapshot } from "./ui/resolve_and_snapshot.js";
import { createComment, listComments, type CreateCommentArgs } from "./comments/comment.js";
import { buildManagerDashboardJson, runManagerDashboard } from "./ui/manager_dashboard.js";
import { startUiWebServer } from "./ui/web_server.js";
import { desktopDoctor } from "./ui/desktop_doctor.js";
import { desktopReleaseDoctor } from "./ui/desktop_release_doctor.js";
import { runJsonRpcServer } from "./server/main.js";
import { buildRunMonitorSnapshot } from "./runtime/run_monitor.js";
import { buildReviewInboxSnapshot } from "./runtime/review_inbox.js";
import { buildUiSnapshot } from "./runtime/ui_bundle.js";
import {
  rebuildSqliteIndex,
  syncSqliteIndex,
  readIndexStats,
  listIndexedRuns,
  listIndexedEvents,
  listIndexedEventParseErrors,
  listIndexedReviews,
  listIndexedHelpRequests
} from "./index/sqlite.js";

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
  .command("workspace:doctor")
  .description("Run workspace health checks (schema, providers, repos, index, worktree references)")
  .argument("<dir>", "Workspace root directory")
  .option("--rebuild-index", "Rebuild SQLite index as part of health checks", false)
  .option("--sync-index", "Incrementally sync SQLite index as part of health checks", false)
  .action(async (dir: string, opts: { rebuildIndex: boolean; syncIndex: boolean }) => {
    await runAction(async () => {
      const report = await doctorWorkspace({
        workspace_dir: dir,
        rebuild_index: opts.rebuildIndex,
        sync_index: opts.syncIndex
      });
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      if (!report.ok) process.exitCode = 2;
    });
  });

program
  .command("workspace:diagnostics")
  .description("Export a diagnostics bundle (doctor + adapters + sessions + monitor + review inbox)")
  .argument("<workspace_dir>", "Workspace root directory")
  .argument("<out_dir>", "Output directory for diagnostics bundle")
  .option("--rebuild-index", "Rebuild index during diagnostics collection", false)
  .option("--no-sync-index", "Skip index sync during diagnostics collection")
  .option("--monitor-limit <n>", "Max run monitor rows", (v) => parseInt(v, 10), 200)
  .option("--pending-limit <n>", "Max pending approvals rows", (v) => parseInt(v, 10), 200)
  .option("--decisions-limit <n>", "Max recent review decisions rows", (v) => parseInt(v, 10), 200)
  .action(
    async (
      workspaceDir: string,
      outDir: string,
      opts: {
        rebuildIndex: boolean;
        syncIndex: boolean;
        monitorLimit: number;
        pendingLimit: number;
        decisionsLimit: number;
      }
    ) => {
      await runAction(async () => {
        const limits = [opts.monitorLimit, opts.pendingLimit, opts.decisionsLimit];
        if (limits.some((n) => !Number.isInteger(n) || n <= 0)) {
          throw new UserError("--monitor-limit, --pending-limit, and --decisions-limit must be positive integers");
        }
        const res = await createWorkspaceDiagnosticsBundle({
          workspace_dir: workspaceDir,
          out_dir: outDir,
          rebuild_index: opts.rebuildIndex,
          sync_index: opts.syncIndex,
          monitor_limit: opts.monitorLimit,
          pending_limit: opts.pendingLimit,
          decisions_limit: opts.decisionsLimit
        });
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      });
    }
  );

program
  .command("workspace:migrate")
  .description("Apply canonical workspace migrations (schema/event format upgrades)")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--dry-run", "Scan and report changes without writing", false)
  .option("--force", "Re-run migration even if already marked as applied", false)
  .action(async (workspaceDir: string, opts: { dryRun: boolean; force: boolean }) => {
    await runAction(async () => {
      const res = await migrateWorkspace({
        workspace_dir: workspaceDir,
        dry_run: opts.dryRun,
        force: opts.force
      });
      process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    });
  });

program
  .command("workspace:export")
  .description("Export canonical workspace content to a clean folder (git/cloud-sync friendly)")
  .argument("<workspace_dir>", "Workspace root directory")
  .argument("<out_dir>", "Output directory for exported workspace content")
  .option("--include-local", "Include .local overlay in export", false)
  .option("--force", "Replace non-empty destination directory", false)
  .action(
    async (
      workspaceDir: string,
      outDir: string,
      opts: { includeLocal: boolean; force: boolean }
    ) => {
      await runAction(async () => {
        const res = await exportWorkspace({
          workspace_dir: workspaceDir,
          out_dir: outDir,
          include_local: opts.includeLocal,
          force: opts.force
        });
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      });
    }
  );

program
  .command("workspace:import")
  .description("Import canonical workspace content from another local workspace folder")
  .argument("<src_dir>", "Source workspace directory")
  .argument("<workspace_dir>", "Destination workspace directory")
  .option("--include-local", "Import .local overlay from source", false)
  .option("--force", "Replace non-empty destination directory", false)
  .action(
    async (
      srcDir: string,
      workspaceDir: string,
      opts: { includeLocal: boolean; force: boolean }
    ) => {
      await runAction(async () => {
        const res = await importWorkspace({
          src_dir: srcDir,
          workspace_dir: workspaceDir,
          include_local: opts.includeLocal,
          force: opts.force
        });
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
        if (!res.validation_ok) process.exitCode = 2;
      });
    }
  );

program
  .command("worktree:cleanup")
  .description("Cleanup ended/stopped/failed task worktrees by retention policy")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--project <project_id>", "Limit cleanup to one project id", undefined)
  .option(
    "--max-age-hours <n>",
    "Only cleanup runs older than this many hours (default: 72)",
    (v) => parseFloat(v),
    72
  )
  .option("--dry-run", "Report cleanup candidates without removing paths", false)
  .action(
    async (
      workspaceDir: string,
      opts: { project?: string; maxAgeHours: number; dryRun: boolean }
    ) => {
      await runAction(async () => {
        if (!Number.isFinite(opts.maxAgeHours) || opts.maxAgeHours < 0) {
          throw new UserError("--max-age-hours must be a non-negative number");
        }
        const res = await cleanupWorktrees({
          workspace_dir: workspaceDir,
          project_id: opts.project,
          max_age_hours: opts.maxAgeHours,
          dry_run: opts.dryRun
        });
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      });
    }
  );

program
  .command("desktop:doctor")
  .description("Check local prerequisites for running the Tauri desktop shell")
  .argument("[workspace_dir]", "Workspace root directory (optional)")
  .option("--project <project_id>", "Project id (optional)", undefined)
  .option("--cli-path <path>", "Explicit path to dist/cli.js (optional)", undefined)
  .option("--node-bin <bin>", "Node binary override (optional)", undefined)
  .action(
    async (
      workspaceDir: string | undefined,
      opts: { project?: string; cliPath?: string; nodeBin?: string }
    ) => {
      await runAction(async () => {
        const report = await desktopDoctor({
          workspace_dir: workspaceDir,
          project_id: opts.project,
          cli_path: opts.cliPath,
          node_bin: opts.nodeBin
        });
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
        if (!report.ok) process.exitCode = 2;
      });
    }
  );

program
  .command("desktop:release-doctor")
  .description("Check desktop release readiness (bundle/updater/channels/signing strategy)")
  .option("--cwd <dir>", "Project root override (defaults to current working directory)", undefined)
  .action(async (opts: { cwd?: string }) => {
    await runAction(async () => {
      const report = await desktopReleaseDoctor({
        cwd: opts.cwd
      });
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      if (!report.ok) process.exitCode = 2;
    });
  });

program
  .command("server:start")
  .description("Start the local JSON-RPC control-plane server over stdio")
  .action(async () => {
    await runAction(async () => {
      await runJsonRpcServer();
    });
  });

program
  .command("demo:init")
  .description("Initialize a demo workspace with 2 teams, managers/workers, and a sample project")
  .argument("<dir>", "Workspace root directory")
  .option("--name <name>", "Company name", "AgentCompany Demo")
  .option("--force", "Initialize even if the directory is non-empty", false)
  .action(async (dir: string, opts: { name: string; force: boolean }) => {
    await runAction(async () => {
      const res = await demoInit({ workspace_dir: dir, company_name: opts.name, force: opts.force });
      process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    });
  });

program
  .command("pipeline:intake")
  .description("Scaffold a project intake pipeline (intake brief + manager proposals + director workplan)")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--name <project_name>", "Project name", "")
  .option("--ceo <agent_id>", "CEO agent id", "")
  .option("--director <agent_id>", "Director agent id", "")
  .option("--managers <agent_ids...>", "Manager agent ids", [])
  .action(
    async (
      workspaceDir: string,
      opts: { name: string; ceo: string; director: string; managers: string[] }
    ) => {
      await runAction(async () => {
        if (!opts.name.trim()) throw new UserError("--name is required");
        if (!opts.ceo.trim()) throw new UserError("--ceo is required");
        if (!opts.director.trim()) throw new UserError("--director is required");
        if (!opts.managers.length) throw new UserError("--managers is required (one or more ids)");
        const res = await scaffoldProjectIntake({
          workspace_dir: workspaceDir,
          project_name: opts.name,
          ceo_agent_id: opts.ceo,
          director_agent_id: opts.director,
          manager_agent_ids: opts.managers
        });
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      });
    }
  );

program
  .command("pipeline:plan")
  .description(
    "Run an end-to-end planning pipeline (intake brief -> manager proposals -> director workplan)"
  )
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--name <project_name>", "Project name", "")
  .option("--ceo <agent_id>", "CEO agent id", "")
  .option("--director <agent_id>", "Director agent id", "")
  .option("--managers <agent_ids...>", "Manager agent ids", [])
  .option("--intake <text>", "CEO brief text (use --intake-file for longer inputs)", "")
  .option("--intake-file <path>", "Path to a file containing the CEO brief", undefined)
  .option("--model <model>", "Provider model override (optional)", undefined)
  .action(
    async (
      workspaceDir: string,
      opts: {
        name: string;
        ceo: string;
        director: string;
        managers: string[];
        intake: string;
        intakeFile?: string;
        model?: string;
      }
    ) => {
      await runAction(async () => {
        if (!opts.name.trim()) throw new UserError("--name is required");
        if (!opts.ceo.trim()) throw new UserError("--ceo is required");
        if (!opts.director.trim()) throw new UserError("--director is required");
        if (!opts.managers.length) throw new UserError("--managers is required (one or more ids)");

        const hasInline = Boolean(opts.intake?.trim());
        const hasFile = Boolean(opts.intakeFile?.trim());
        if (!hasInline && !hasFile) {
          throw new UserError("Provide one of --intake or --intake-file");
        }
        if (hasInline && hasFile) {
          throw new UserError("Provide only one of --intake or --intake-file");
        }
        const intakeText = hasFile
          ? await fs.readFile(opts.intakeFile!, { encoding: "utf8" })
          : opts.intake;

        const res = await runPlanningPipeline({
          workspace_dir: workspaceDir,
          project_name: opts.name,
          ceo_agent_id: opts.ceo,
          director_agent_id: opts.director,
          manager_agent_ids: opts.managers,
          intake_brief: intakeText,
          model: opts.model
        });
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      });
    }
  );

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
  .command("agent:record-mistake")
  .description(
    "Record a repeated worker mistake (manager action) and auto-promote a rule to worker AGENTS.md after threshold"
  )
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--worker <agent_id>", "Worker agent id", "")
  .option("--manager <actor_id>", "Manager actor id", "")
  .option("--manager-role <role>", "Manager actor role (human|ceo|director|manager)", "manager")
  .option("--key <mistake_key>", "Stable mistake key", "")
  .option("--summary <summary>", "Human-readable mistake summary", "")
  .option("--rule <prevention_rule>", "Rule to add into worker AGENTS.md on repeat", "")
  .option("--project <project_id>", "Project id (optional; used for event logging)", undefined)
  .option("--run <run_id>", "Run id (optional; used for event logging)", undefined)
  .option("--task <task_id>", "Task id (optional)", undefined)
  .option("--milestone <milestone_id>", "Milestone id (optional)", undefined)
  .option("--evidence <artifact_ids...>", "Evidence artifact ids (optional)", [])
  .option("--threshold <n>", "Promotion threshold (default 3)", (v) => parseInt(v, 10), 3)
  .action(
    async (
      workspaceDir: string,
      opts: {
        worker: string;
        manager: string;
        managerRole: string;
        key: string;
        summary: string;
        rule: string;
        project?: string;
        run?: string;
        task?: string;
        milestone?: string;
        evidence: string[];
        threshold: number;
      }
    ) => {
      await runAction(async () => {
        if (!opts.worker.trim()) throw new UserError("--worker is required");
        if (!opts.manager.trim()) throw new UserError("--manager is required");
        if (!opts.key.trim()) throw new UserError("--key is required");
        if (!opts.summary.trim()) throw new UserError("--summary is required");
        if (!opts.rule.trim()) throw new UserError("--rule is required");
        const role = opts.managerRole as any;
        if (!["human", "ceo", "director", "manager"].includes(role)) {
          throw new UserError("Invalid --manager-role. Valid: human, ceo, director, manager");
        }
        const res = await recordAgentMistake({
          workspace_dir: workspaceDir,
          worker_agent_id: opts.worker,
          manager_actor_id: opts.manager,
          manager_role: role,
          mistake_key: opts.key,
          summary: opts.summary,
          prevention_rule: opts.rule,
          project_id: opts.project,
          run_id: opts.run,
          task_id: opts.task,
          milestone_id: opts.milestone,
          evidence_artifact_ids: opts.evidence.length ? opts.evidence : undefined,
          promote_threshold: opts.threshold
        });
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      });
    }
  );

program
  .command("agent:refresh-context")
  .description(
    "Refresh the managed context index section in an agent AGENTS.md from assigned task contracts"
  )
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--agent <agent_id>", "Agent id", "")
  .option("--project <project_id>", "Optional project id filter", undefined)
  .option("--max-tasks <n>", "Maximum assigned tasks to include", (v) => parseInt(v, 10), 20)
  .option(
    "--max-scope-paths <n>",
    "Maximum scoped task paths to include",
    (v) => parseInt(v, 10),
    40
  )
  .action(
    async (
      workspaceDir: string,
      opts: {
        agent: string;
        project?: string;
        maxTasks: number;
        maxScopePaths: number;
      }
    ) => {
      await runAction(async () => {
        if (!opts.agent.trim()) throw new UserError("--agent is required");
        const res = await refreshAgentContextIndex({
          workspace_dir: workspaceDir,
          agent_id: opts.agent,
          project_id: opts.project,
          max_tasks: opts.maxTasks,
          max_scope_paths: opts.maxScopePaths
        });
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
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
  .option("--stdin-file <path>", "Read stdin content from a file and pipe to the command", undefined)
  .option("--repo <repo_id>", "Repo id (resolves via .local/machine.yaml)", undefined)
  .option("--subdir <workdir_rel>", "Workdir relative to repo root", undefined)
  .option("--task <task_id>", "Task id (enables task-aware execution behavior)", undefined)
  .option("--milestone <milestone_id>", "Milestone id (used with --task)", undefined)
  .action(
    async (
      workspaceDir: string,
      opts: {
        project: string;
        run: string;
        argv: string[];
        stdinFile?: string;
        repo?: string;
        subdir?: string;
        task?: string;
        milestone?: string;
      }
    ) => {
      await runAction(async () => {
        if (!opts.project.trim()) throw new UserError("--project is required");
        if (!opts.run.trim()) throw new UserError("--run is required");
        if (!opts.argv.length) throw new UserError("--argv is required (use --argv cmd arg1 arg2)");
        if (opts.milestone && !opts.task) {
          throw new UserError("--milestone requires --task");
        }
        const stdinText = opts.stdinFile
          ? await fs.readFile(opts.stdinFile, { encoding: "utf8" })
          : undefined;
        const res = await executeCommandRun({
          workspace_dir: workspaceDir,
          project_id: opts.project,
          run_id: opts.run,
          argv: opts.argv,
          stdin_text: stdinText,
          repo_id: opts.repo,
          workdir_rel: opts.subdir,
          task_id: opts.task,
          milestone_id: opts.milestone
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
  .command("index:rebuild")
  .description("Rebuild SQLite index cache from canonical filesystem artifacts")
  .argument("<workspace_dir>", "Workspace root directory")
  .action(async (workspaceDir: string) => {
    await runAction(async () => {
      const res = await rebuildSqliteIndex(workspaceDir);
      process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    });
  });

program
  .command("index:sync")
  .description("Incrementally sync SQLite index cache from canonical filesystem artifacts")
  .argument("<workspace_dir>", "Workspace root directory")
  .action(async (workspaceDir: string) => {
    await runAction(async () => {
      const res = await syncSqliteIndex(workspaceDir);
      process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    });
  });

program
  .command("index:stats")
  .description("Show SQLite index table counts")
  .argument("<workspace_dir>", "Workspace root directory")
  .action(async (workspaceDir: string) => {
    await runAction(async () => {
      const stats = await readIndexStats(workspaceDir);
      process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
    });
  });

program
  .command("index:runs")
  .description("List indexed runs from SQLite cache")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--project <project_id>", "Project id filter", undefined)
  .option("--status <status>", "Status filter (running|ended|failed|stopped)", undefined)
  .option("--limit <n>", "Max rows", (v) => parseInt(v, 10), 200)
  .action(
    async (
      workspaceDir: string,
      opts: { project?: string; status?: string; limit: number }
    ) => {
      await runAction(async () => {
        if (opts.status && !["running", "ended", "failed", "stopped"].includes(opts.status)) {
          throw new UserError("Invalid --status. Valid: running, ended, failed, stopped");
        }
        const rows = await listIndexedRuns({
          workspace_dir: workspaceDir,
          project_id: opts.project,
          status: opts.status,
          limit: opts.limit
        });
        process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
      });
    }
  );

program
  .command("index:reviews")
  .description("List indexed review records from SQLite cache")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--project <project_id>", "Project id filter", undefined)
  .option("--decision <decision>", "Decision filter (approved|denied)", undefined)
  .option("--limit <n>", "Max rows", (v) => parseInt(v, 10), 200)
  .action(
    async (
      workspaceDir: string,
      opts: { project?: string; decision?: string; limit: number }
    ) => {
      await runAction(async () => {
        if (opts.decision && !["approved", "denied"].includes(opts.decision)) {
          throw new UserError("Invalid --decision. Valid: approved, denied");
        }
        const rows = await listIndexedReviews({
          workspace_dir: workspaceDir,
          project_id: opts.project,
          decision: opts.decision as "approved" | "denied" | undefined,
          limit: opts.limit
        });
        process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
      });
    }
  );

program
  .command("index:help")
  .description("List indexed help requests from SQLite cache")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--project <project_id>", "Project id filter", undefined)
  .option("--target <manager_id>", "Target manager filter", undefined)
  .option("--limit <n>", "Max rows", (v) => parseInt(v, 10), 200)
  .action(
    async (
      workspaceDir: string,
      opts: { project?: string; target?: string; limit: number }
    ) => {
      await runAction(async () => {
        const rows = await listIndexedHelpRequests({
          workspace_dir: workspaceDir,
          project_id: opts.project,
          target_manager: opts.target,
          limit: opts.limit
        });
        process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
      });
    }
  );

program
  .command("index:events")
  .description("List indexed events from SQLite cache (for run monitor tails/filters)")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--project <project_id>", "Project id filter", undefined)
  .option("--run <run_id>", "Run id filter", undefined)
  .option("--type <event_type>", "Event type filter", undefined)
  .option("--since-seq <n>", "Only events with seq > n", (v) => parseInt(v, 10), undefined)
  .option("--limit <n>", "Max rows", (v) => parseInt(v, 10), 200)
  .option("--order <order>", "Sort order (asc|desc)", "desc")
  .action(
    async (
      workspaceDir: string,
      opts: {
        project?: string;
        run?: string;
        type?: string;
        sinceSeq?: number;
        limit: number;
        order: string;
      }
    ) => {
      await runAction(async () => {
        if (opts.order !== "asc" && opts.order !== "desc") {
          throw new UserError("Invalid --order. Valid: asc, desc");
        }
        if (opts.sinceSeq !== undefined && Number.isNaN(opts.sinceSeq)) {
          throw new UserError("Invalid --since-seq. Must be an integer >= 0");
        }
        const rows = await listIndexedEvents({
          workspace_dir: workspaceDir,
          project_id: opts.project,
          run_id: opts.run,
          type: opts.type,
          since_seq: opts.sinceSeq,
          limit: opts.limit,
          order: opts.order as "asc" | "desc"
        });
        process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
      });
    }
  );

program
  .command("index:event-errors")
  .description("List indexed event parse errors captured during index rebuild")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--project <project_id>", "Project id filter", undefined)
  .option("--run <run_id>", "Run id filter", undefined)
  .option("--limit <n>", "Max rows", (v) => parseInt(v, 10), 200)
  .action(
    async (
      workspaceDir: string,
      opts: {
        project?: string;
        run?: string;
        limit: number;
      }
    ) => {
      await runAction(async () => {
        const rows = await listIndexedEventParseErrors({
          workspace_dir: workspaceDir,
          project_id: opts.project,
          run_id: opts.run,
          limit: opts.limit
        });
        process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
      });
    }
  );

program
  .command("monitor:runs")
  .description("Build a run monitor snapshot (indexed runs/events + live sessions)")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--project <project_id>", "Project id filter", undefined)
  .option("--limit <n>", "Max rows", (v) => parseInt(v, 10), 200)
  .option("--refresh-index", "Rebuild index before generating snapshot", false)
  .option("--no-sync-index", "Skip incremental index sync before generating snapshot")
  .action(
    async (
      workspaceDir: string,
      opts: { project?: string; limit: number; refreshIndex: boolean; syncIndex: boolean }
    ) => {
      await runAction(async () => {
        const snapshot = await buildRunMonitorSnapshot({
          workspace_dir: workspaceDir,
          project_id: opts.project,
          limit: opts.limit,
          refresh_index: opts.refreshIndex,
          sync_index: opts.syncIndex
        });
        process.stdout.write(JSON.stringify(snapshot, null, 2) + "\n");
      });
    }
  );

program
  .command("inbox:snapshot")
  .description("Build an indexed review inbox snapshot (pending approvals + recent decisions)")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--project <project_id>", "Project id filter", undefined)
  .option("--pending-limit <n>", "Max pending rows", (v) => parseInt(v, 10), 200)
  .option("--decisions-limit <n>", "Max recent decision rows", (v) => parseInt(v, 10), 200)
  .option("--refresh-index", "Rebuild index before generating snapshot", false)
  .option("--no-sync-index", "Skip incremental index sync before generating snapshot")
  .action(
    async (
      workspaceDir: string,
      opts: {
        project?: string;
        pendingLimit: number;
        decisionsLimit: number;
        refreshIndex: boolean;
        syncIndex: boolean;
      }
    ) => {
      await runAction(async () => {
        const snapshot = await buildReviewInboxSnapshot({
          workspace_dir: workspaceDir,
          project_id: opts.project,
          pending_limit: opts.pendingLimit,
          decisions_limit: opts.decisionsLimit,
          refresh_index: opts.refreshIndex,
          sync_index: opts.syncIndex
        });
        process.stdout.write(JSON.stringify(snapshot, null, 2) + "\n");
      });
    }
  );

program
  .command("inbox:resolve")
  .description("Resolve a pending inbox artifact decision (approved|denied)")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--project <project_id>", "Project id", "")
  .option("--artifact <artifact_id>", "Artifact id (art_...)", "")
  .option("--decision <decision>", "Decision (approved|denied)", "approved")
  .option("--actor <actor_id>", "Actor id (human or agent id)", "human")
  .option("--role <role>", "Actor role (human|ceo|director|manager|worker)", "human")
  .option("--team <team_id>", "Actor team id (optional)", undefined)
  .option("--notes <notes>", "Decision notes", "")
  .action(
    async (
      workspaceDir: string,
      opts: {
        project: string;
        artifact: string;
        decision: string;
        actor: string;
        role: string;
        team?: string;
        notes: string;
      }
    ) => {
      await runAction(async () => {
        if (!opts.project.trim()) throw new UserError("--project is required");
        if (!opts.artifact.trim()) throw new UserError("--artifact is required");
        if (!["approved", "denied"].includes(opts.decision)) {
          throw new UserError("Invalid --decision. Valid: approved, denied");
        }
        const role = opts.role as any;
        if (!["human", "ceo", "director", "manager", "worker"].includes(role)) {
          throw new UserError("Invalid --role. Valid: human, ceo, director, manager, worker");
        }
        const res = await resolveInboxItem({
          workspace_dir: workspaceDir,
          project_id: opts.project,
          artifact_id: opts.artifact,
          decision: opts.decision as "approved" | "denied",
          actor_id: opts.actor,
          actor_role: role,
          actor_team_id: opts.team,
          notes: opts.notes
        });
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      });
    }
  );

program
  .command("comment:add")
  .description("Add a persisted colleague note/comment for an agent, artifact, or run")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--project <project_id>", "Project id", "")
  .option("--author <author_id>", "Author actor id (human or agent id)", "human")
  .option("--role <role>", "Author role (human|ceo|director|manager|worker)", "manager")
  .option("--body <text>", "Comment body", "")
  .option("--target-agent <agent_id>", "Target colleague agent id", undefined)
  .option("--target-artifact <artifact_id>", "Target artifact id", undefined)
  .option("--target-run <run_id>", "Target run id", undefined)
  .option(
    "--visibility <visibility>",
    "Visibility (private_agent|team|managers|org)",
    "managers"
  )
  .action(
    async (
      workspaceDir: string,
      opts: {
        project: string;
        author: string;
        role: string;
        body: string;
        targetAgent?: string;
        targetArtifact?: string;
        targetRun?: string;
        visibility: string;
      }
    ) => {
      await runAction(async () => {
        if (!opts.project.trim()) throw new UserError("--project is required");
        if (!opts.body.trim()) throw new UserError("--body is required");
        if (!opts.author.trim()) throw new UserError("--author is required");
        const roleValues: CreateCommentArgs["author_role"][] = [
          "human",
          "ceo",
          "director",
          "manager",
          "worker"
        ];
        if (!roleValues.includes(opts.role as CreateCommentArgs["author_role"])) {
          throw new UserError("Invalid --role. Valid: human, ceo, director, manager, worker");
        }
        const visibilityParsed = Visibility.safeParse(opts.visibility);
        if (!visibilityParsed.success) {
          throw new UserError(
            "Invalid --visibility. Valid: private_agent, team, managers, org"
          );
        }
        const role = opts.role as CreateCommentArgs["author_role"];
        const created = await createComment({
          workspace_dir: workspaceDir,
          project_id: opts.project,
          author_id: opts.author,
          author_role: role,
          body: opts.body,
          target_agent_id: opts.targetAgent,
          target_artifact_id: opts.targetArtifact,
          target_run_id: opts.targetRun,
          visibility: visibilityParsed.data
        });
        process.stdout.write(JSON.stringify(created, null, 2) + "\n");
      });
    }
  );

program
  .command("comment:list")
  .description("List persisted colleague comments for a project")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--project <project_id>", "Project id", "")
  .option("--target-agent <agent_id>", "Filter by target agent id", undefined)
  .option("--target-artifact <artifact_id>", "Filter by target artifact id", undefined)
  .option("--target-run <run_id>", "Filter by target run id", undefined)
  .option("--limit <n>", "Max rows", (v) => parseInt(v, 10), 200)
  .action(
    async (
      workspaceDir: string,
      opts: {
        project: string;
        targetAgent?: string;
        targetArtifact?: string;
        targetRun?: string;
        limit: number;
      }
    ) => {
      await runAction(async () => {
        if (!opts.project.trim()) throw new UserError("--project is required");
        const comments = await listComments({
          workspace_dir: workspaceDir,
          project_id: opts.project,
          target_agent_id: opts.targetAgent,
          target_artifact_id: opts.targetArtifact,
          target_run_id: opts.targetRun,
          limit: opts.limit
        });
        process.stdout.write(JSON.stringify(comments, null, 2) + "\n");
      });
    }
  );

program
  .command("ui:snapshot")
  .description("Build a thin UI bundle snapshot (run monitor + review inbox)")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--project <project_id>", "Project id filter", undefined)
  .option("--monitor-limit <n>", "Max run monitor rows", (v) => parseInt(v, 10), 200)
  .option("--pending-limit <n>", "Max pending inbox rows", (v) => parseInt(v, 10), 200)
  .option("--decisions-limit <n>", "Max recent decision rows", (v) => parseInt(v, 10), 200)
  .option("--refresh-index", "Rebuild index before generating snapshot", false)
  .option("--no-sync-index", "Skip incremental index sync before generating snapshot")
  .action(
    async (
      workspaceDir: string,
      opts: {
        project?: string;
        monitorLimit: number;
        pendingLimit: number;
        decisionsLimit: number;
        refreshIndex: boolean;
        syncIndex: boolean;
      }
    ) => {
      await runAction(async () => {
        const snapshot = await buildUiSnapshot({
          workspace_dir: workspaceDir,
          project_id: opts.project,
          monitor_limit: opts.monitorLimit,
          pending_limit: opts.pendingLimit,
          decisions_limit: opts.decisionsLimit,
          refresh_index: opts.refreshIndex,
          sync_index: opts.syncIndex
        });
        process.stdout.write(JSON.stringify(snapshot, null, 2) + "\n");
      });
    }
  );

program
  .command("ui:resolve")
  .description("Resolve an inbox item and return an updated thin UI snapshot in one call")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--project <project_id>", "Project id", "")
  .option("--artifact <artifact_id>", "Artifact id (art_...)", "")
  .option("--decision <decision>", "Decision (approved|denied)", "approved")
  .option("--actor <actor_id>", "Actor id (human or agent id)", "human")
  .option("--role <role>", "Actor role (human|ceo|director|manager|worker)", "human")
  .option("--team <team_id>", "Actor team id (optional)", undefined)
  .option("--notes <notes>", "Decision notes", "")
  .option("--monitor-limit <n>", "Max run monitor rows", (v) => parseInt(v, 10), 200)
  .option("--pending-limit <n>", "Max pending inbox rows", (v) => parseInt(v, 10), 200)
  .option("--decisions-limit <n>", "Max recent decision rows", (v) => parseInt(v, 10), 200)
  .option("--refresh-index", "Rebuild index before generating snapshot", false)
  .option("--no-sync-index", "Skip incremental index sync before generating snapshot")
  .action(
    async (
      workspaceDir: string,
      opts: {
        project: string;
        artifact: string;
        decision: string;
        actor: string;
        role: string;
        team?: string;
        notes: string;
        monitorLimit: number;
        pendingLimit: number;
        decisionsLimit: number;
        refreshIndex: boolean;
        syncIndex: boolean;
      }
    ) => {
      await runAction(async () => {
        if (!opts.project.trim()) throw new UserError("--project is required");
        if (!opts.artifact.trim()) throw new UserError("--artifact is required");
        if (!["approved", "denied"].includes(opts.decision)) {
          throw new UserError("Invalid --decision. Valid: approved, denied");
        }
        const role = opts.role as any;
        if (!["human", "ceo", "director", "manager", "worker"].includes(role)) {
          throw new UserError("Invalid --role. Valid: human, ceo, director, manager, worker");
        }
        const res = await resolveInboxAndBuildUiSnapshot({
          workspace_dir: workspaceDir,
          project_id: opts.project,
          artifact_id: opts.artifact,
          decision: opts.decision as "approved" | "denied",
          actor_id: opts.actor,
          actor_role: role,
          actor_team_id: opts.team,
          notes: opts.notes,
          monitor_limit: opts.monitorLimit,
          pending_limit: opts.pendingLimit,
          decisions_limit: opts.decisionsLimit,
          refresh_index: opts.refreshIndex,
          sync_index: opts.syncIndex
        });
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      });
    }
  );

program
  .command("ui:manager-dashboard")
  .description("Interactive manager dashboard loop (run monitor + review inbox + resolve commands)")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--project <project_id>", "Project id", "")
  .option("--actor <actor_id>", "Actor id (human or agent id)", "human")
  .option("--role <role>", "Actor role (human|ceo|director|manager|worker)", "manager")
  .option("--team <team_id>", "Actor team id (optional)", undefined)
  .option("--monitor-limit <n>", "Max run monitor rows", (v) => parseInt(v, 10), 200)
  .option("--pending-limit <n>", "Max pending inbox rows", (v) => parseInt(v, 10), 200)
  .option("--decisions-limit <n>", "Max recent decision rows", (v) => parseInt(v, 10), 200)
  .option("--refresh-index", "Rebuild index before initial snapshot", false)
  .option("--no-sync-index", "Skip incremental index sync before snapshots")
  .option("--once", "Render one snapshot and exit", false)
  .option("--json", "Print a compact JSON snapshot and exit", false)
  .option("--no-clear-screen", "Do not clear terminal between refreshes")
  .action(
    async (
      workspaceDir: string,
      opts: {
        project: string;
        actor: string;
        role: string;
        team?: string;
        monitorLimit: number;
        pendingLimit: number;
        decisionsLimit: number;
        refreshIndex: boolean;
        syncIndex: boolean;
        once: boolean;
        json: boolean;
        clearScreen: boolean;
      }
    ) => {
      await runAction(async () => {
        if (!opts.project.trim()) throw new UserError("--project is required");
        const role = opts.role as any;
        if (!["human", "ceo", "director", "manager", "worker"].includes(role)) {
          throw new UserError("Invalid --role. Valid: human, ceo, director, manager, worker");
        }
        if (opts.json) {
          const payload = await buildManagerDashboardJson({
            workspace_dir: workspaceDir,
            project_id: opts.project,
            actor_id: opts.actor,
            actor_role: role,
            actor_team_id: opts.team,
            monitor_limit: opts.monitorLimit,
            pending_limit: opts.pendingLimit,
            decisions_limit: opts.decisionsLimit,
            refresh_index: opts.refreshIndex,
            sync_index: opts.syncIndex
          });
          process.stdout.write(`${JSON.stringify(payload)}\n`);
          return;
        }
        await runManagerDashboard({
          workspace_dir: workspaceDir,
          project_id: opts.project,
          actor_id: opts.actor,
          actor_role: role,
          actor_team_id: opts.team,
          monitor_limit: opts.monitorLimit,
          pending_limit: opts.pendingLimit,
          decisions_limit: opts.decisionsLimit,
          refresh_index: opts.refreshIndex,
          sync_index: opts.syncIndex,
          once: opts.once,
          clear_screen: opts.clearScreen
        });
      });
    }
  );

program
  .command("ui:web")
  .description("Start a local web UI server for run monitor + review inbox")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--project <project_id>", "Project id", "")
  .option("--actor <actor_id>", "Actor id (human or agent id)", "human")
  .option("--role <role>", "Actor role (human|ceo|director|manager|worker)", "manager")
  .option("--team <team_id>", "Actor team id (optional)", undefined)
  .option("--host <host>", "Listen host", "127.0.0.1")
  .option("--port <n>", "Listen port (0 for random)", (v) => parseInt(v, 10), 8787)
  .option("--monitor-limit <n>", "Max run monitor rows", (v) => parseInt(v, 10), 200)
  .option("--pending-limit <n>", "Max pending inbox rows", (v) => parseInt(v, 10), 200)
  .option("--decisions-limit <n>", "Max recent decision rows", (v) => parseInt(v, 10), 200)
  .option("--refresh-index", "Rebuild index before initial reads", false)
  .option("--no-sync-index", "Skip incremental index sync before reads")
  .action(
    async (
      workspaceDir: string,
      opts: {
        project: string;
        actor: string;
        role: string;
        team?: string;
        host: string;
        port: number;
        monitorLimit: number;
        pendingLimit: number;
        decisionsLimit: number;
        refreshIndex: boolean;
        syncIndex: boolean;
      }
    ) => {
      await runAction(async () => {
        if (!opts.project.trim()) throw new UserError("--project is required");
        const role = opts.role as any;
        if (!["human", "ceo", "director", "manager", "worker"].includes(role)) {
          throw new UserError("Invalid --role. Valid: human, ceo, director, manager, worker");
        }
        if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
          throw new UserError("--port must be an integer between 0 and 65535");
        }

        const web = await startUiWebServer({
          workspace_dir: workspaceDir,
          project_id: opts.project,
          actor_id: opts.actor,
          actor_role: role,
          actor_team_id: opts.team,
          host: opts.host,
          port: opts.port,
          monitor_limit: opts.monitorLimit,
          pending_limit: opts.pendingLimit,
          decisions_limit: opts.decisionsLimit,
          refresh_index: opts.refreshIndex,
          sync_index: opts.syncIndex
        });

        process.stdout.write(`UI web server listening at ${web.url}\n`);
        process.stdout.write("Press Ctrl+C to stop.\n");

        await new Promise<void>((resolve) => {
          let closing = false;
          const shutdown = async (): Promise<void> => {
            if (closing) return;
            closing = true;
            process.off("SIGINT", onSigint);
            process.off("SIGTERM", onSigterm);
            try {
              await web.close();
            } finally {
              resolve();
            }
          };
          const onSigint = (): void => {
            void shutdown();
          };
          const onSigterm = (): void => {
            void shutdown();
          };
          process.on("SIGINT", onSigint);
          process.on("SIGTERM", onSigterm);
        });
      });
    }
  );

program
  .command("run:replay")
  .description("Replay a run timeline from events.jsonl")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--project <project_id>", "Project id", "")
  .option("--run <run_id>", "Run id", "")
  .option("--tail <n>", "Show only the last N events", (v) => parseInt(v, 10), undefined)
  .option("--mode <mode>", "Replay mode (raw|verified|deterministic|live)", "raw")
  .action(
    async (
      workspaceDir: string,
      opts: { project: string; run: string; tail?: number; mode: string }
    ) => {
      await runAction(async () => {
        if (!opts.project.trim()) throw new UserError("--project is required");
        if (!opts.run.trim()) throw new UserError("--run is required");
        if (!["raw", "verified", "deterministic", "live"].includes(opts.mode)) {
          throw new UserError("Invalid --mode. Valid: raw, verified, deterministic, live");
        }
        const mode = opts.mode as "raw" | "verified" | "deterministic" | "live";
        const replay = await replayRun({
          workspace_dir: workspaceDir,
          project_id: opts.project,
          run_id: opts.run,
          tail: opts.tail,
          mode
        });
        for (const ev of replay.events) {
          if (!ev || typeof ev !== "object") {
            process.stdout.write(`[event] ${JSON.stringify(ev)}\n`);
            continue;
          }
          const row = ev as Record<string, unknown>;
          const ts = String(row.ts_wallclock ?? "");
          const type = String(row.type ?? "");
          const actor = String(row.actor ?? "");
          process.stdout.write(`${ts} ${type} actor=${actor}\n`);
        }
        for (const issue of replay.parse_issues) {
          process.stdout.write(`[parse_error] seq=${issue.seq} ${issue.error}\n`);
        }
        for (const issue of replay.verification_issues) {
          process.stdout.write(`[verify_issue] seq=${issue.seq} ${issue.code}: ${issue.message}\n`);
        }
        if (mode === "deterministic") {
          process.stdout.write(`[deterministic] ${replay.deterministic_ok ? "ok" : "not_ok"}\n`);
        }
        if (mode === "live") {
          const live = replay.live;
          process.stdout.write(
            `[live] available=${live.available ? "yes" : "no"}${
              live.session_ref ? ` session_ref=${live.session_ref}` : ""
            }${live.status ? ` status=${live.status}` : ""}${
              live.error ? ` error=${live.error}` : ""
            }\n`
          );
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
  .command("sharepack:create")
  .description("Create a Share Pack bundle for cross-team sharing (managers/org visible artifacts only)")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--project <project_id>", "Project id", "")
  .option("--by <actor_id>", "Creator actor id (human or agent id)", "human")
  .action(async (workspaceDir: string, opts: { project: string; by: string }) => {
    await runAction(async () => {
      if (!opts.project.trim()) throw new UserError("--project is required");
      const res = await createSharePack({
        workspace_dir: workspaceDir,
        project_id: opts.project,
        created_by: opts.by
      });
      process.stdout.write(JSON.stringify(res) + "\n");
    });
  });

program
  .command("sharepack:replay")
  .description("Replay bundled run events from a share pack")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--project <project_id>", "Project id", "")
  .option("--share <share_pack_id>", "Share pack id", "")
  .option("--run <run_id>", "Run id included in share pack (optional)", undefined)
  .option("--tail <n>", "Show only the last N events per run", (v) => parseInt(v, 10), undefined)
  .option("--mode <mode>", "Replay mode (raw|verified|deterministic)", "raw")
  .action(
    async (
      workspaceDir: string,
      opts: { project: string; share: string; run?: string; tail?: number; mode: string }
    ) => {
      await runAction(async () => {
        if (!opts.project.trim()) throw new UserError("--project is required");
        if (!opts.share.trim()) throw new UserError("--share is required");
        if (!["raw", "verified", "deterministic"].includes(opts.mode)) {
          throw new UserError("Invalid --mode. Valid: raw, verified, deterministic");
        }
        const mode = opts.mode as "raw" | "verified" | "deterministic";
        const res = await replaySharePack({
          workspace_dir: workspaceDir,
          project_id: opts.project,
          share_pack_id: opts.share,
          run_id: opts.run,
          tail: opts.tail,
          mode
        });
        process.stdout.write(JSON.stringify(res) + "\n");
      });
    }
  );

program
  .command("help:new")
  .description("Create a new help request (stored in inbox/help_requests)")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--title <title>", "Help request title", "")
  .option("--requester <id>", "Requester actor id (human or agent id)", "human")
  .option("--target <id>", "Target manager agent id", "")
  .option("--project <project_id>", "Project id (optional)", undefined)
  .option("--share <share_pack_id>", "Share pack id (optional)", undefined)
  .option("--visibility <visibility>", "Visibility (private_agent|team|managers|org)", "managers")
  .action(
    async (
      workspaceDir: string,
      opts: {
        title: string;
        requester: string;
        target: string;
        project?: string;
        share?: string;
        visibility: string;
      }
    ) => {
      await runAction(async () => {
        if (!opts.title.trim()) throw new UserError("--title is required");
        if (!opts.target.trim()) throw new UserError("--target is required");
        const visParsed = Visibility.safeParse(opts.visibility);
        if (!visParsed.success) {
          throw new UserError(
            `Invalid visibility "${opts.visibility}". Valid: ${Visibility.options.join(", ")}`
          );
        }
        const res = await createHelpRequestFile(workspaceDir, {
          title: opts.title,
          visibility: visParsed.data,
          requester: opts.requester,
          target_manager: opts.target,
          project_id: opts.project,
          share_pack_id: opts.share
        });
        process.stdout.write(JSON.stringify(res) + "\n");
      });
    }
  );

program
  .command("help:validate")
  .description("Validate a single help request markdown file (front matter + required sections)")
  .argument("<file>", "Help request markdown file path")
  .action(async (file: string) => {
    await runAction(async () => {
      const md = await fs.readFile(file, { encoding: "utf8" });
      const res = validateHelpRequestMarkdown(md);
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
  .command("artifact:fill")
  .description(
    "Fill an existing project artifact using a provider CLI (creates a run + overwrites the artifact)"
  )
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--project <project_id>", "Project id", "")
  .option("--artifact <artifact_id>", "Artifact id (art_...)", "")
  .option("--agent <agent_id>", "Agent id", "")
  .option("--provider <provider>", "Override provider (defaults to agent.yaml)", undefined)
  .option("--model <model>", "Provider model (optional)", undefined)
  .option("--prompt <text>", "Extra prompt/instructions", "")
  .option("--prompt-file <path>", "Read extra prompt/instructions from a file", undefined)
  .option("--repo <repo_id>", "Repo id (optional; snapshots into context pack)", undefined)
  .option("--subdir <workdir_rel>", "Workdir relative to repo root", undefined)
  .action(
    async (
      workspaceDir: string,
      opts: {
        project: string;
        artifact: string;
        agent: string;
        provider?: string;
        model?: string;
        prompt: string;
        promptFile?: string;
        repo?: string;
        subdir?: string;
      }
    ) => {
      await runAction(async () => {
        if (!opts.project.trim()) throw new UserError("--project is required");
        if (!opts.artifact.trim()) throw new UserError("--artifact is required");
        if (!opts.agent.trim()) throw new UserError("--agent is required");

        const hasInline = Boolean(opts.prompt?.trim());
        const hasFile = Boolean(opts.promptFile?.trim());
        if (hasInline && hasFile) {
          throw new UserError("Provide only one of --prompt or --prompt-file");
        }
        const extra = hasFile
          ? await fs.readFile(opts.promptFile!, { encoding: "utf8" })
          : (opts.prompt ?? "");

        const res = await fillArtifactWithProvider({
          workspace_dir: workspaceDir,
          project_id: opts.project,
          artifact_id: opts.artifact,
          agent_id: opts.agent,
          provider: opts.provider,
          model: opts.model,
          prompt: extra,
          repo_id: opts.repo,
          workdir_rel: opts.subdir
        });
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
        if (!res.ok) process.exitCode = 2;
      });
    }
  );

program
  .command("artifact:read")
  .description("Read a project artifact with policy enforcement (supports policy.denied audit events)")
  .argument("<workspace_dir>", "Workspace root directory")
  .option("--project <project_id>", "Project id", "")
  .option("--artifact <artifact_id>", "Artifact id (art_...)", "")
  .option("--actor <actor_id>", "Actor id (human or agent id)", "human")
  .option("--role <role>", "Actor role (human|ceo|director|manager|worker)", "human")
  .option("--team <team_id>", "Actor team id (optional)", undefined)
  .option("--run <run_id>", "Audit run id (optional; enables policy.denied event logging)", undefined)
  .action(
    async (
      workspaceDir: string,
      opts: {
        project: string;
        artifact: string;
        actor: string;
        role: string;
        team?: string;
        run?: string;
      }
    ) => {
      await runAction(async () => {
        if (!opts.project.trim()) throw new UserError("--project is required");
        if (!opts.artifact.trim()) throw new UserError("--artifact is required");
        if (!["human", "ceo", "director", "manager", "worker"].includes(opts.role)) {
          throw new UserError("Invalid --role. Valid: human, ceo, director, manager, worker");
        }
        const res = await readArtifactWithPolicy({
          workspace_dir: workspaceDir,
          project_id: opts.project,
          artifact_id: opts.artifact,
          actor_id: opts.actor,
          actor_role: opts.role as "human" | "ceo" | "director" | "manager" | "worker",
          actor_team_id: opts.team,
          run_id: opts.run
        });
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
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

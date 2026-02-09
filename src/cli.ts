#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs/promises";
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

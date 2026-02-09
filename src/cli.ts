#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs/promises";
import process from "node:process";
import { initWorkspace } from "./workspace/init.js";
import { validateWorkspace } from "./workspace/validate.js";
import { ArtifactType, newArtifactMarkdown, validateMarkdownArtifact } from "./artifacts/markdown.js";
import { writeFileAtomic } from "./store/fs.js";
import { Visibility } from "./schemas/common.js";

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

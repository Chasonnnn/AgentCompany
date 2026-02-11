import fs from "node:fs/promises";
import path from "node:path";
import { nowIso } from "../core/time.js";
import { createRun } from "../runtime/run.js";
import { executeCommandRun } from "../runtime/execute_command.js";
import { validateMarkdownArtifact } from "../artifacts/markdown.js";
import { newArtifactMarkdown } from "../artifacts/markdown.js";
import { writeFileAtomic } from "../store/fs.js";
import { newEnvelope, appendEventJsonl } from "../runtime/events.js";
import { resolveProviderBin } from "../drivers/resolve_bin.js";
import { getDriver } from "../drivers/registry.js";
import { readYamlFile } from "../store/yaml.js";
import { AgentYaml } from "../schemas/agent.js";
import { newId } from "../core/ids.js";
import { extractClaudeMarkdownFromStreamJson } from "../drivers/claude_stream_json.js";

export type ArtifactFillArgs = {
  workspace_dir: string;
  project_id: string;
  artifact_id: string;
  agent_id: string;
  // If omitted, uses agent.yaml provider.
  provider?: string;
  model?: string;
  prompt: string;
  repo_id?: string;
  workdir_rel?: string;
};

export type ArtifactFillResult =
  | {
      ok: true;
      run_id: string;
      context_pack_id: string;
      artifact_id: string;
      artifact_relpath: string;
    }
  | {
      ok: false;
      error: string;
      run_id?: string;
      context_pack_id?: string;
      failure_artifact_id?: string;
    };

function buildFillPrompt(template: string, extra: string): string {
  const rules = [
    "Return ONLY a complete Markdown document.",
    "Do not wrap the document in triple backticks.",
    "The output MUST start with the YAML front matter exactly as provided in the template (do not change keys/values unless explicitly instructed).",
    "Keep all required headings from the template; fill in the sections with concrete content.",
    "Do not include any commentary outside the Markdown document."
  ].join("\n- ");

  return [
    "You are generating an internal AgentCompany artifact.",
    "",
    "Rules:",
    `- ${rules}`,
    "",
    "Additional instructions:",
    extra.trim() ? extra.trim() : "(none)",
    "",
    "Template to fill (copy and complete):",
    template
  ].join("\n");
}

function parseGeneratedOutput(raw: string, parser?: "claude_stream_json"): string {
  switch (parser) {
    case "claude_stream_json":
      return extractClaudeMarkdownFromStreamJson(raw);
    default:
      return raw;
  }
}

async function readAgentProvider(workspaceDir: string, agentId: string): Promise<string> {
  const p = path.join(workspaceDir, "org/agents", agentId, "agent.yaml");
  const doc = AgentYaml.parse(await readYamlFile(p));
  return doc.provider;
}

export async function fillArtifactWithProvider(args: ArtifactFillArgs): Promise<ArtifactFillResult> {
  const artifactRel = path.join(
    "work/projects",
    args.project_id,
    "artifacts",
    `${args.artifact_id}.md`
  );
  const artifactAbs = path.join(args.workspace_dir, artifactRel);

  let existing: string;
  try {
    existing = await fs.readFile(artifactAbs, { encoding: "utf8" });
  } catch (e) {
    return { ok: false, error: `Failed to read artifact: ${(e as Error).message}` };
  }

  const existingValidated = validateMarkdownArtifact(existing);
  if (!existingValidated.ok) {
    const msg = existingValidated.issues.map((i) => i.message).join("; ");
    return { ok: false, error: `Existing artifact is invalid: ${msg}` };
  }

  // Create a new run for provenance, and regenerate the template with matching id/type/title/visibility.
  const provider = args.provider ?? (await readAgentProvider(args.workspace_dir, args.agent_id));
  const run = await createRun({
    workspace_dir: args.workspace_dir,
    project_id: args.project_id,
    agent_id: args.agent_id,
    provider
  });

  const template = newArtifactMarkdown({
    type: existingValidated.frontmatter.type,
    title: existingValidated.frontmatter.title,
    visibility: existingValidated.frontmatter.visibility,
    produced_by: args.agent_id,
    run_id: run.run_id,
    context_pack_id: run.context_pack_id,
    id: args.artifact_id,
    created_at: nowIso()
  });

  const prompt = buildFillPrompt(template, args.prompt);
  const { driver, bin } = await resolveProviderBin(args.workspace_dir, provider);
  const drv = getDriver(driver);

  const outputsDirAbs = path.join(run.run_dir, "outputs");
  const built = drv.buildArtifactFillCommand({
    bin,
    prompt,
    model: args.model,
    outputs_dir_abs: outputsDirAbs
  });

  try {
    const execRes = await executeCommandRun({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id,
      run_id: run.run_id,
      argv: built.argv,
      env: built.env,
      stdin_text: built.stdin_text,
      repo_id: args.repo_id,
      workdir_rel: args.workdir_rel
    });

    if (execRes.exit_code !== 0) {
      return {
        ok: false,
        error: `Provider command failed (exit_code=${execRes.exit_code})`,
        run_id: run.run_id,
        context_pack_id: run.context_pack_id
      };
    }

    const stdoutPath = path.join(outputsDirAbs, "stdout.txt");
    const finalTextPath = built.final_text_file_abs ?? stdoutPath;
    const rawGenerated = await fs.readFile(finalTextPath, { encoding: "utf8" });
    const generated = parseGeneratedOutput(rawGenerated, built.final_text_parser);

    const validated = validateMarkdownArtifact(generated);
    if (!validated.ok) {
      const msg = validated.issues.map((i) => i.message).join("; ");
      return {
        ok: false,
        error: `Generated artifact is invalid: ${msg}`,
        run_id: run.run_id,
        context_pack_id: run.context_pack_id
      };
    }

    // Enforce key provenance fields match what we asked for.
    if (validated.frontmatter.id !== args.artifact_id) {
      return {
        ok: false,
        error: `Generated artifact id mismatch (expected ${args.artifact_id}, got ${validated.frontmatter.id})`,
        run_id: run.run_id,
        context_pack_id: run.context_pack_id
      };
    }
    if (validated.frontmatter.produced_by !== args.agent_id) {
      return {
        ok: false,
        error: `Generated produced_by mismatch (expected ${args.agent_id}, got ${validated.frontmatter.produced_by})`,
        run_id: run.run_id,
        context_pack_id: run.context_pack_id
      };
    }
    if (validated.frontmatter.run_id !== run.run_id) {
      return {
        ok: false,
        error: `Generated run_id mismatch (expected ${run.run_id}, got ${validated.frontmatter.run_id})`,
        run_id: run.run_id,
        context_pack_id: run.context_pack_id
      };
    }
    if (validated.frontmatter.context_pack_id !== run.context_pack_id) {
      return {
        ok: false,
        error: `Generated context_pack_id mismatch (expected ${run.context_pack_id}, got ${validated.frontmatter.context_pack_id})`,
        run_id: run.run_id,
        context_pack_id: run.context_pack_id
      };
    }

    // Overwrite the canonical artifact file with the generated output.
    await writeFileAtomic(artifactAbs, generated);

    // Record as produced in run events.
    const eventsAbs = path.join(
      args.workspace_dir,
      "work/projects",
      args.project_id,
      "runs",
      run.run_id,
      "events.jsonl"
    );
    await appendEventJsonl(
      eventsAbs,
      newEnvelope({
        schema_version: 1,
        ts_wallclock: nowIso(),
        run_id: run.run_id,
        session_ref: `local_${run.run_id}`,
        actor: args.agent_id,
        visibility: validated.frontmatter.visibility,
        type: "artifact.produced",
        payload: {
          artifact_id: args.artifact_id,
          relpath: artifactRel,
          artifact_type: validated.frontmatter.type
        }
      })
    );

    return {
      ok: true,
      run_id: run.run_id,
      context_pack_id: run.context_pack_id,
      artifact_id: args.artifact_id,
      artifact_relpath: artifactRel
    };
  } catch (e) {
    // Best-effort: write a failure report artifact for provenance/debugging.
    const failureId = newId("art");
    const failureRel = path.join("work/projects", args.project_id, "artifacts", `${failureId}.md`);
    const failureAbs = path.join(args.workspace_dir, failureRel);
    const md = newArtifactMarkdown({
      type: "failure_report",
      title: `Failure: fill artifact ${args.artifact_id}`,
      visibility: "managers",
      produced_by: "system",
      run_id: run.run_id,
      context_pack_id: run.context_pack_id,
      id: failureId,
      created_at: nowIso()
    });
    const detail = `\n\n## Summary\n\nFailed to fill artifact.\n\n## Cause\n\n${String(
      e instanceof Error ? e.message : e
    )}\n\n## Next Steps\n\n- Inspect run outputs and events.jsonl\n`;
    await writeFileAtomic(failureAbs, md + detail);
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      run_id: run.run_id,
      context_pack_id: run.context_pack_id,
      failure_artifact_id: failureId
    };
  }
}

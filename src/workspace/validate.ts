import path from "node:path";
import fs from "node:fs/promises";
import { z } from "zod";
import { CompanyYaml } from "../schemas/company.js";
import { PolicyYaml } from "../schemas/policy.js";
import { TeamYaml } from "../schemas/team.js";
import { AgentYaml } from "../schemas/agent.js";
import { ProjectYaml } from "../schemas/project.js";
import { MachineYaml } from "../schemas/machine.js";
import { RunYaml } from "../schemas/run.js";
import { ContextPackManifestYaml, PolicySnapshotYaml } from "../schemas/context_pack.js";
import { pathExists } from "../store/fs.js";
import { readYamlFile } from "../store/yaml.js";
import { REQUIRED_DIRS, REQUIRED_FILES } from "./layout.js";
import { validateTaskMarkdown } from "../work/task_markdown.js";
import { validateMarkdownArtifact } from "../artifacts/markdown.js";
import { parseMemoryDeltaMarkdown } from "../memory/memory_delta.js";
import { ReviewYaml } from "../schemas/review.js";
import { parseMilestoneReportMarkdown } from "../milestones/milestone_report.js";
import { validateHelpRequestMarkdown } from "../help/help_request.js";
import { SharePackManifestYaml } from "../schemas/share_pack.js";

export type ValidationIssue = {
  code: string;
  message: string;
  path?: string;
};

export type ValidationResult =
  | { ok: true }
  | {
      ok: false;
      issues: ValidationIssue[];
    };

function zodIssuesToIssues(filePath: string, err: z.ZodError): ValidationIssue[] {
  return err.issues.map((i) => ({
    code: "schema_invalid",
    message: `${filePath}: ${i.path.join(".")}: ${i.message}`,
    path: filePath
  }));
}

export async function validateWorkspace(rootDir: string): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [];

  for (const d of REQUIRED_DIRS) {
    const p = path.join(rootDir, d);
    if (!(await pathExists(p))) {
      issues.push({ code: "missing_dir", message: `Missing directory: ${d}`, path: d });
    }
  }

  for (const f of REQUIRED_FILES) {
    const p = path.join(rootDir, f);
    if (!(await pathExists(p))) {
      issues.push({ code: "missing_file", message: `Missing file: ${f}`, path: f });
    }
  }

  // Validate company and policy schemas.
  const companyPath = path.join(rootDir, "company/company.yaml");
  if (await pathExists(companyPath)) {
    try {
      const doc = await readYamlFile(companyPath);
      CompanyYaml.parse(doc);
    } catch (e) {
      if (e instanceof z.ZodError) issues.push(...zodIssuesToIssues("company/company.yaml", e));
      else issues.push({ code: "parse_error", message: `company/company.yaml: ${(e as Error).message}` });
    }
  }

  const policyPath = path.join(rootDir, "company/policy.yaml");
  if (await pathExists(policyPath)) {
    try {
      const doc = await readYamlFile(policyPath);
      PolicyYaml.parse(doc);
    } catch (e) {
      if (e instanceof z.ZodError) issues.push(...zodIssuesToIssues("company/policy.yaml", e));
      else issues.push({ code: "parse_error", message: `company/policy.yaml: ${(e as Error).message}` });
    }
  }

  // Validate review records.
  const reviewsDir = path.join(rootDir, "inbox/reviews");
  try {
    const entries = await fs.readdir(reviewsDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!ent.name.endsWith(".yaml")) continue;
      const rel = path.join("inbox/reviews", ent.name);
      const p = path.join(rootDir, rel);
      try {
        const doc = await readYamlFile(p);
        ReviewYaml.parse(doc);
      } catch (e) {
        if (e instanceof z.ZodError) issues.push(...zodIssuesToIssues(rel, e));
        else issues.push({ code: "parse_error", message: `${rel}: ${(e as Error).message}`, path: rel });
      }
    }
  } catch {
    // If the directory doesn't exist, REQUIRED_DIRS will already report it.
  }

  // Validate help requests.
  const helpDir = path.join(rootDir, "inbox/help_requests");
  try {
    const entries = await fs.readdir(helpDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!ent.name.endsWith(".md")) continue;
      const rel = path.join("inbox/help_requests", ent.name);
      const p = path.join(rootDir, rel);
      try {
        const md = await fs.readFile(p, { encoding: "utf8" });
        const res = validateHelpRequestMarkdown(md);
        if (!res.ok) {
          for (const i of res.issues) {
            issues.push({ code: i.code, message: `${rel}: ${i.message}`, path: rel });
          }
        }
      } catch (e) {
        issues.push({ code: "read_error", message: `${rel}: ${(e as Error).message}`, path: rel });
      }
    }
  } catch {
    // ignore
  }

  const machinePath = path.join(rootDir, ".local/machine.yaml");
  if (await pathExists(machinePath)) {
    try {
      const doc = await readYamlFile(machinePath);
      MachineYaml.parse(doc);
    } catch (e) {
      if (e instanceof z.ZodError) issues.push(...zodIssuesToIssues(".local/machine.yaml", e));
      else issues.push({ code: "parse_error", message: `.local/machine.yaml: ${(e as Error).message}` });
    }
  }

  // Validate teams.
  const teamsDir = path.join(rootDir, "org/teams");
  try {
    const entries = await fs.readdir(teamsDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const rel = path.join("org/teams", ent.name, "team.yaml");
      const p = path.join(rootDir, rel);
      if (!(await pathExists(p))) {
        issues.push({ code: "missing_file", message: `Missing file: ${rel}`, path: rel });
        continue;
      }
      try {
        const doc = await readYamlFile(p);
        TeamYaml.parse(doc);
      } catch (e) {
        if (e instanceof z.ZodError) issues.push(...zodIssuesToIssues(rel, e));
        else issues.push({ code: "parse_error", message: `${rel}: ${(e as Error).message}`, path: rel });
      }
    }
  } catch {
    // If the directory doesn't exist, REQUIRED_DIRS will already report it.
  }

  // Validate agents.
  const agentsDir = path.join(rootDir, "org/agents");
  try {
    const entries = await fs.readdir(agentsDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const rel = path.join("org/agents", ent.name, "agent.yaml");
      const p = path.join(rootDir, rel);
      if (!(await pathExists(p))) {
        issues.push({ code: "missing_file", message: `Missing file: ${rel}`, path: rel });
        continue;
      }
      try {
        const doc = await readYamlFile(p);
        AgentYaml.parse(doc);
      } catch (e) {
        if (e instanceof z.ZodError) issues.push(...zodIssuesToIssues(rel, e));
        else issues.push({ code: "parse_error", message: `${rel}: ${(e as Error).message}`, path: rel });
      }
    }
  } catch {
    // If the directory doesn't exist, REQUIRED_DIRS will already report it.
  }

  // Validate projects.
  const projectsDir = path.join(rootDir, "work/projects");
  try {
    const entries = await fs.readdir(projectsDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const projectId = ent.name;
      const projectRel = path.join("work/projects", projectId, "project.yaml");
      const projectAbs = path.join(rootDir, projectRel);
      if (!(await pathExists(projectAbs))) {
        issues.push({ code: "missing_file", message: `Missing file: ${projectRel}`, path: projectRel });
        continue;
      }
      try {
        const doc = await readYamlFile(projectAbs);
        ProjectYaml.parse(doc);
      } catch (e) {
        if (e instanceof z.ZodError) issues.push(...zodIssuesToIssues(projectRel, e));
        else
          issues.push({
            code: "parse_error",
            message: `${projectRel}: ${(e as Error).message}`,
            path: projectRel
          });
      }

      // Validate runs under this project.
      const runsDir = path.join(rootDir, "work/projects", projectId, "runs");
      try {
        const runEntries = await fs.readdir(runsDir, { withFileTypes: true });
        for (const r of runEntries) {
          if (!r.isDirectory()) continue;
          const runId = r.name;
          const runRel = path.join("work/projects", projectId, "runs", runId, "run.yaml");
          const runAbs = path.join(rootDir, runRel);
          if (!(await pathExists(runAbs))) {
            issues.push({ code: "missing_file", message: `Missing file: ${runRel}`, path: runRel });
            continue;
          }
          try {
            const doc = await readYamlFile(runAbs);
            RunYaml.parse(doc);
          } catch (e) {
            if (e instanceof z.ZodError) issues.push(...zodIssuesToIssues(runRel, e));
            else issues.push({ code: "parse_error", message: `${runRel}: ${(e as Error).message}`, path: runRel });
          }

          const eventsRel = path.join("work/projects", projectId, "runs", runId, "events.jsonl");
          const eventsAbs = path.join(rootDir, eventsRel);
          if (!(await pathExists(eventsAbs))) {
            issues.push({
              code: "missing_file",
              message: `Missing file: ${eventsRel}`,
              path: eventsRel
            });
          }
        }
      } catch {
        // If missing, ignore here; REQUIRED_DIRS doesn't require project subdirs yet.
      }

      // Validate tasks under this project.
      const tasksDir = path.join(rootDir, "work/projects", projectId, "tasks");
      try {
        const taskEntries = await fs.readdir(tasksDir, { withFileTypes: true });
        for (const t of taskEntries) {
          if (!t.isFile()) continue;
          if (!t.name.endsWith(".md")) continue;
          const rel = path.join("work/projects", projectId, "tasks", t.name);
          const p = path.join(rootDir, rel);
          try {
            const md = await fs.readFile(p, { encoding: "utf8" });
            const res = validateTaskMarkdown(md);
            if (!res.ok) {
              for (const i of res.issues) {
                issues.push({
                  code: i.code,
                  message: `${rel}: ${i.message}`,
                  path: rel
                });
              }
            }
          } catch (e) {
            issues.push({ code: "read_error", message: `${rel}: ${(e as Error).message}`, path: rel });
          }
        }
      } catch {
        // ignore
      }

      // Validate artifacts under this project.
      const artifactsDir = path.join(rootDir, "work/projects", projectId, "artifacts");
      try {
        const artifactEntries = await fs.readdir(artifactsDir, { withFileTypes: true });
        for (const a of artifactEntries) {
          if (!a.isFile()) continue;
          if (a.name.endsWith(".md")) {
            const rel = path.join("work/projects", projectId, "artifacts", a.name);
            const p = path.join(rootDir, rel);
            try {
              const md = await fs.readFile(p, { encoding: "utf8" });
              const res = validateMarkdownArtifact(md);
              if (!res.ok) {
                for (const i of res.issues) {
                  issues.push({ code: i.code, message: `${rel}: ${i.message}`, path: rel });
                }
              } else if (res.frontmatter.type === "memory_delta") {
                const parsed = parseMemoryDeltaMarkdown(md);
                if (!parsed.ok) {
                  issues.push({
                    code: "memory_delta_invalid",
                    message: `${rel}: ${parsed.error}`,
                    path: rel
                  });
                } else {
                  const patchAbs = path.join(rootDir, parsed.frontmatter.patch_file);
                  if (!(await pathExists(patchAbs))) {
                    issues.push({
                      code: "missing_file",
                      message: `Missing patch_file for memory delta: ${parsed.frontmatter.patch_file}`,
                      path: parsed.frontmatter.patch_file
                    });
                  }
                }
              } else if (res.frontmatter.type === "milestone_report") {
                const parsed = parseMilestoneReportMarkdown(md);
                if (!parsed.ok) {
                  issues.push({
                    code: "milestone_report_invalid",
                    message: `${rel}: ${parsed.error}`,
                    path: rel
                  });
                }
              }
            } catch (e) {
              issues.push({ code: "read_error", message: `${rel}: ${(e as Error).message}`, path: rel });
            }
          }
        }
      } catch {
        // ignore
      }

      // Validate context packs under this project.
      const ctxRoot = path.join(rootDir, "work/projects", projectId, "context_packs");
      try {
        const ctxEntries = await fs.readdir(ctxRoot, { withFileTypes: true });
        for (const c of ctxEntries) {
          if (!c.isDirectory()) continue;
          const ctxId = c.name;

          const manifestRel = path.join(
            "work/projects",
            projectId,
            "context_packs",
            ctxId,
            "manifest.yaml"
          );
          const manifestAbs = path.join(rootDir, manifestRel);
          if (!(await pathExists(manifestAbs))) {
            issues.push({
              code: "missing_file",
              message: `Missing file: ${manifestRel}`,
              path: manifestRel
            });
            continue;
          }
          try {
            const doc = await readYamlFile(manifestAbs);
            ContextPackManifestYaml.parse(doc);
          } catch (e) {
            if (e instanceof z.ZodError) issues.push(...zodIssuesToIssues(manifestRel, e));
            else
              issues.push({
                code: "parse_error",
                message: `${manifestRel}: ${(e as Error).message}`,
                path: manifestRel
              });
          }

          const policyRel = path.join(
            "work/projects",
            projectId,
            "context_packs",
            ctxId,
            "policy_snapshot.yaml"
          );
          const policyAbs = path.join(rootDir, policyRel);
          if (!(await pathExists(policyAbs))) {
            issues.push({ code: "missing_file", message: `Missing file: ${policyRel}`, path: policyRel });
            continue;
          }
          try {
            const doc = await readYamlFile(policyAbs);
            PolicySnapshotYaml.parse(doc);
          } catch (e) {
            if (e instanceof z.ZodError) issues.push(...zodIssuesToIssues(policyRel, e));
            else
              issues.push({
                code: "parse_error",
                message: `${policyRel}: ${(e as Error).message}`,
                path: policyRel
              });
          }
        }
      } catch {
        // ignore
      }

      // Validate share packs under this project.
      const shareRoot = path.join(rootDir, "work/projects", projectId, "share_packs");
      try {
        const shareEntries = await fs.readdir(shareRoot, { withFileTypes: true });
        for (const sEnt of shareEntries) {
          if (!sEnt.isDirectory()) continue;
          const shareId = sEnt.name;
          const manifestRel = path.join(
            "work/projects",
            projectId,
            "share_packs",
            shareId,
            "manifest.yaml"
          );
          const manifestAbs = path.join(rootDir, manifestRel);
          if (!(await pathExists(manifestAbs))) {
            issues.push({
              code: "missing_file",
              message: `Missing file: ${manifestRel}`,
              path: manifestRel
            });
            continue;
          }
          try {
            const doc = await readYamlFile(manifestAbs);
            const manifest = SharePackManifestYaml.parse(doc);
            for (const inc of manifest.included_artifacts) {
              const bundleAbs = path.join(rootDir, inc.bundle_relpath);
              if (!(await pathExists(bundleAbs))) {
                issues.push({
                  code: "missing_file",
                  message: `Missing bundled artifact file: ${inc.bundle_relpath}`,
                  path: inc.bundle_relpath
                });
              }
            }
            for (const inc of manifest.included_files ?? []) {
              const bundleAbs = path.join(rootDir, inc.bundle_relpath);
              if (!(await pathExists(bundleAbs))) {
                issues.push({
                  code: "missing_file",
                  message: `Missing bundled file: ${inc.bundle_relpath}`,
                  path: inc.bundle_relpath
                });
              }
            }
          } catch (e) {
            if (e instanceof z.ZodError) issues.push(...zodIssuesToIssues(manifestRel, e));
            else
              issues.push({
                code: "parse_error",
                message: `${manifestRel}: ${(e as Error).message}`,
                path: manifestRel
              });
          }
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // If the directory doesn't exist, REQUIRED_DIRS will already report it.
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

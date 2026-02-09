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
    }
  } catch {
    // If the directory doesn't exist, REQUIRED_DIRS will already report it.
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

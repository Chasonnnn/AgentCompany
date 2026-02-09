import path from "node:path";
import fs from "node:fs/promises";
import { z } from "zod";
import { CompanyYaml } from "../schemas/company.js";
import { PolicyYaml } from "../schemas/policy.js";
import { TeamYaml } from "../schemas/team.js";
import { AgentYaml } from "../schemas/agent.js";
import { ProjectYaml } from "../schemas/project.js";
import { MachineYaml } from "../schemas/machine.js";
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
      const rel = path.join("work/projects", ent.name, "project.yaml");
      const p = path.join(rootDir, rel);
      if (!(await pathExists(p))) {
        issues.push({ code: "missing_file", message: `Missing file: ${rel}`, path: rel });
        continue;
      }
      try {
        const doc = await readYamlFile(p);
        ProjectYaml.parse(doc);
      } catch (e) {
        if (e instanceof z.ZodError) issues.push(...zodIssuesToIssues(rel, e));
        else issues.push({ code: "parse_error", message: `${rel}: ${(e as Error).message}`, path: rel });
      }
    }
  } catch {
    // If the directory doesn't exist, REQUIRED_DIRS will already report it.
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

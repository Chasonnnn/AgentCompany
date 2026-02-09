import path from "node:path";
import { z } from "zod";
import { CompanyYaml } from "../schemas/company.js";
import { PolicyYaml } from "../schemas/policy.js";
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

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}


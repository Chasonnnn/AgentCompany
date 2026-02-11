import fs from "node:fs/promises";
import path from "node:path";
import type { BudgetThreshold } from "../schemas/budget.js";
import { ProjectYaml } from "../schemas/project.js";
import { RunYaml, type RunUsageSummary } from "../schemas/run.js";
import { readYamlFile } from "../store/yaml.js";
import { parseFrontMatter } from "../artifacts/frontmatter.js";
import { TaskFrontMatter } from "../work/task_markdown.js";

export type BudgetScope = "run" | "task" | "project";
export type BudgetMetric = "cost_usd" | "tokens";
export type BudgetSeverity = "soft" | "hard";

export type BudgetFinding = {
  scope: BudgetScope;
  metric: BudgetMetric;
  severity: BudgetSeverity;
  threshold: number;
  actual: number;
};

export type BudgetDecision = BudgetFinding & {
  result: "ok" | "alert" | "exceeded";
};

export type BudgetEvaluation = {
  decisions: BudgetDecision[];
  alerts: BudgetFinding[];
  exceeded: BudgetFinding[];
};

function safeNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

type UsageTotals = {
  tokens: number;
  cost_usd: number;
};

function usageToTotals(usage?: RunUsageSummary): UsageTotals {
  return {
    tokens: usage?.total_tokens ?? 0,
    cost_usd: safeNumber(usage?.cost_usd)
  };
}

function applyBudgetThreshold(
  scope: BudgetScope,
  budget: BudgetThreshold,
  totals: UsageTotals
): BudgetEvaluation {
  const decisions: BudgetDecision[] = [];
  const alerts: BudgetFinding[] = [];
  const exceeded: BudgetFinding[] = [];

  const checks: Array<{
    metric: BudgetMetric;
    severity: BudgetSeverity;
    threshold?: number;
    actual: number;
  }> = [
    { metric: "cost_usd", severity: "soft", threshold: budget.soft_cost_usd, actual: totals.cost_usd },
    { metric: "cost_usd", severity: "hard", threshold: budget.hard_cost_usd, actual: totals.cost_usd },
    { metric: "tokens", severity: "soft", threshold: budget.soft_tokens, actual: totals.tokens },
    { metric: "tokens", severity: "hard", threshold: budget.hard_tokens, actual: totals.tokens }
  ];

  for (const c of checks) {
    if (c.threshold === undefined) continue;
    const finding: BudgetFinding = {
      scope,
      metric: c.metric,
      severity: c.severity,
      threshold: c.threshold,
      actual: c.actual
    };
    if (c.actual >= c.threshold) {
      if (c.severity === "hard") {
        exceeded.push(finding);
        decisions.push({ ...finding, result: "exceeded" });
      } else {
        alerts.push(finding);
        decisions.push({ ...finding, result: "alert" });
      }
    } else {
      decisions.push({ ...finding, result: "ok" });
    }
  }

  return { decisions, alerts, exceeded };
}

async function readProjectBudget(workspaceDir: string, projectId: string): Promise<BudgetThreshold | undefined> {
  const p = path.join(workspaceDir, "work/projects", projectId, "project.yaml");
  const project = ProjectYaml.parse(await readYamlFile(p));
  return project.budget;
}

async function readTaskBudget(
  workspaceDir: string,
  projectId: string,
  taskId: string
): Promise<BudgetThreshold | undefined> {
  const p = path.join(workspaceDir, "work/projects", projectId, "tasks", `${taskId}.md`);
  const md = await fs.readFile(p, { encoding: "utf8" });
  const parsed = parseFrontMatter(md);
  if (!parsed.ok) throw new Error(parsed.error);
  const fm = TaskFrontMatter.parse(parsed.frontmatter);
  return fm.budget;
}

async function listRunDocs(workspaceDir: string, projectId: string): Promise<RunYaml[]> {
  const runsDir = path.join(workspaceDir, "work/projects", projectId, "runs");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(runsDir);
  } catch {
    return [];
  }
  const out: RunYaml[] = [];
  for (const runId of entries) {
    const runYamlPath = path.join(runsDir, runId, "run.yaml");
    try {
      out.push(RunYaml.parse(await readYamlFile(runYamlPath)));
    } catch {
      // skip invalid run docs
    }
  }
  return out;
}

function sumTotals(runs: RunYaml[]): UsageTotals {
  return runs.reduce<UsageTotals>(
    (acc, run) => {
      const totals = usageToTotals(run.usage);
      return {
        tokens: acc.tokens + totals.tokens,
        cost_usd: acc.cost_usd + totals.cost_usd
      };
    },
    { tokens: 0, cost_usd: 0 }
  );
}

export async function evaluateBudgetForCompletedRun(args: {
  workspace_dir: string;
  project_id: string;
  run_id: string;
  task_id?: string;
  run_budget?: BudgetThreshold;
}): Promise<BudgetEvaluation> {
  const evalOut: BudgetEvaluation = { decisions: [], alerts: [], exceeded: [] };
  const runYamlPath = path.join(
    args.workspace_dir,
    "work/projects",
    args.project_id,
    "runs",
    args.run_id,
    "run.yaml"
  );
  const currentRun = RunYaml.parse(await readYamlFile(runYamlPath));

  if (args.run_budget) {
    const runEval = applyBudgetThreshold("run", args.run_budget, usageToTotals(currentRun.usage));
    evalOut.decisions.push(...runEval.decisions);
    evalOut.alerts.push(...runEval.alerts);
    evalOut.exceeded.push(...runEval.exceeded);
  }

  const projectBudget = await readProjectBudget(args.workspace_dir, args.project_id).catch(() => undefined);
  if (projectBudget) {
    const allRuns = await listRunDocs(args.workspace_dir, args.project_id);
    const projectEval = applyBudgetThreshold("project", projectBudget, sumTotals(allRuns));
    evalOut.decisions.push(...projectEval.decisions);
    evalOut.alerts.push(...projectEval.alerts);
    evalOut.exceeded.push(...projectEval.exceeded);
  }

  if (args.task_id) {
    const taskBudget = await readTaskBudget(args.workspace_dir, args.project_id, args.task_id).catch(
      () => undefined
    );
    if (taskBudget) {
      const allRuns = await listRunDocs(args.workspace_dir, args.project_id);
      const taskRuns = allRuns.filter((run) => run.spec?.task_id === args.task_id);
      const taskEval = applyBudgetThreshold("task", taskBudget, sumTotals(taskRuns));
      evalOut.decisions.push(...taskEval.decisions);
      evalOut.alerts.push(...taskEval.alerts);
      evalOut.exceeded.push(...taskEval.exceeded);
    }
  }

  return evalOut;
}

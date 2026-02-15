import fs from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import { z } from "zod";
import { nowIso } from "../core/time.js";
import { pathExists, writeFileAtomic } from "../store/fs.js";
import { readYamlFile } from "../store/yaml.js";
import { RunYaml } from "../schemas/run.js";
import { listProjects } from "../work/projects_list.js";
import type { UsageAnalyticsSnapshot } from "./usage_analytics.js";

type UsageReconciliationSource = "manual" | "api";

const UsageStatement = z
  .object({
    schema_version: z.literal(1),
    type: z.literal("usage_reconciliation_statement"),
    statement_id: z.string().min(1),
    provider: z.string().min(1),
    provider_key: z.string().min(1),
    period_start: z.string().min(1),
    period_end: z.string().min(1),
    currency: z.literal("USD"),
    billed_cost_usd: z.number().finite().nonnegative(),
    billed_tokens: z.number().int().nonnegative().optional(),
    source: z.enum(["manual", "api"]),
    external_ref: z.string().min(1).optional(),
    notes: z.string().min(1).optional(),
    imported_at: z.string().min(1)
  })
  .strict();

type UsageStatement = z.infer<typeof UsageStatement>;

const UsageStatementDoc = z
  .object({
    schema_version: z.literal(1),
    type: z.literal("usage_reconciliation_statements"),
    updated_at: z.string().min(1),
    statements: z.array(UsageStatement)
  })
  .strict();

type UsageStatementDoc = z.infer<typeof UsageStatementDoc>;

type ProviderRollup = {
  provider: string;
  run_count: number;
  tokens: number;
  cost_usd: number;
};

function round6(v: number): number {
  return Math.round(v * 1_000_000) / 1_000_000;
}

function statementPath(workspaceDir: string): string {
  return path.join(workspaceDir, ".local", "billing", "reconciliation_statements.json");
}

function normalizeProvider(provider: string): string {
  const value = provider.trim().toLowerCase();
  if (value === "codex_app_server" || value === "codex-app-server") return "codex";
  if (value === "claude_code" || value === "claude-code") return "claude";
  return value || "unknown";
}

function parseIsoMs(value: string | undefined, label: string): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`${label} must be an ISO date-time string.`);
  }
  return ms;
}

function emptyStatementDoc(): UsageStatementDoc {
  return {
    schema_version: 1,
    type: "usage_reconciliation_statements",
    updated_at: nowIso(),
    statements: []
  };
}

async function readStatementDoc(workspaceDir: string): Promise<UsageStatementDoc> {
  const abs = statementPath(workspaceDir);
  if (!(await pathExists(abs))) return emptyStatementDoc();
  const raw = await fs.readFile(abs, { encoding: "utf8" });
  const parsed = JSON.parse(raw) as unknown;
  return UsageStatementDoc.parse(parsed);
}

async function writeStatementDoc(workspaceDir: string, doc: UsageStatementDoc): Promise<void> {
  const abs = statementPath(workspaceDir);
  const normalized: UsageStatementDoc = {
    ...doc,
    updated_at: nowIso(),
    statements: [...doc.statements].sort((a, b) => b.imported_at.localeCompare(a.imported_at))
  };
  await writeFileAtomic(abs, `${JSON.stringify(normalized, null, 2)}\n`);
}

function inWindow(tsMs: number, startMs: number | null, endMs: number | null): boolean {
  if (startMs !== null && tsMs < startMs) return false;
  if (endMs !== null && tsMs > endMs) return false;
  return true;
}

function overlapsWindow(
  statementStartMs: number,
  statementEndMs: number,
  startMs: number | null,
  endMs: number | null
): boolean {
  const windowStart = startMs ?? Number.NEGATIVE_INFINITY;
  const windowEnd = endMs ?? Number.POSITIVE_INFINITY;
  return statementEndMs >= windowStart && statementStartMs <= windowEnd;
}

async function collectInternalUsageFromRuns(args: {
  workspace_dir: string;
  project_id?: string;
  period_start?: string;
  period_end?: string;
}): Promise<{
  totals: {
    run_count: number;
    total_tokens: number;
    total_cost_usd: number;
    priced_run_count: number;
    unpriced_run_count: number;
    provider_reported_run_count: number;
    estimated_run_count: number;
  };
  by_provider: Map<string, ProviderRollup>;
}> {
  const startMs = parseIsoMs(args.period_start, "period_start");
  const endMs = parseIsoMs(args.period_end, "period_end");
  if (startMs !== null && endMs !== null && endMs < startMs) {
    throw new Error("period_end must be greater than or equal to period_start.");
  }

  const projects =
    args.project_id != null
      ? [{ project_id: args.project_id }]
      : await listProjects({ workspace_dir: args.workspace_dir });
  const providerMap = new Map<string, ProviderRollup>();
  const totals = {
    run_count: 0,
    total_tokens: 0,
    total_cost_usd: 0,
    priced_run_count: 0,
    unpriced_run_count: 0,
    provider_reported_run_count: 0,
    estimated_run_count: 0
  };

  for (const project of projects) {
    const runsRoot = path.join(args.workspace_dir, "work", "projects", project.project_id, "runs");
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(runsRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const run = RunYaml.parse(await readYamlFile(path.join(runsRoot, entry.name, "run.yaml")));
        const createdMs = Date.parse(run.created_at);
        if (!Number.isFinite(createdMs)) continue;
        if (!inWindow(createdMs, startMs, endMs)) continue;
        const providerKey = normalizeProvider(run.provider);
        const tokens = run.usage?.total_tokens ?? 0;
        const cost = run.usage?.cost_usd ?? 0;
        const rollup =
          providerMap.get(providerKey) ??
          ({
            provider: providerKey,
            run_count: 0,
            tokens: 0,
            cost_usd: 0
          } satisfies ProviderRollup);
        rollup.run_count += 1;
        rollup.tokens += tokens;
        rollup.cost_usd += cost;
        providerMap.set(providerKey, rollup);
        totals.run_count += 1;
        totals.total_tokens += tokens;
        totals.total_cost_usd += cost;
        if (run.usage?.cost_usd != null) totals.priced_run_count += 1;
        else totals.unpriced_run_count += 1;
        if (run.usage?.source === "provider_reported") totals.provider_reported_run_count += 1;
        if (run.usage?.source === "estimated_chars") totals.estimated_run_count += 1;
      } catch {
        // best-effort: skip malformed run.yaml
      }
    }
  }

  return {
    totals: {
      ...totals,
      total_cost_usd: round6(totals.total_cost_usd)
    },
    by_provider: providerMap
  };
}

function collectInternalUsageFromAnalytics(usage: UsageAnalyticsSnapshot): {
  totals: {
    run_count: number;
    total_tokens: number;
    total_cost_usd: number;
    priced_run_count: number;
    unpriced_run_count: number;
    provider_reported_run_count: number;
    estimated_run_count: number;
  };
  by_provider: Map<string, ProviderRollup>;
} {
  const byProvider = new Map<string, ProviderRollup>();
  for (const row of usage.by_provider) {
    byProvider.set(normalizeProvider(row.provider), {
      provider: normalizeProvider(row.provider),
      run_count: row.run_count,
      tokens: row.total_tokens,
      cost_usd: row.total_cost_usd
    });
  }
  return {
    totals: {
      run_count: usage.totals.run_count,
      total_tokens: usage.totals.total_tokens,
      total_cost_usd: usage.totals.total_cost_usd,
      priced_run_count: usage.totals.priced_run_count,
      unpriced_run_count: usage.totals.unpriced_run_count,
      provider_reported_run_count: usage.totals.provider_reported_count,
      estimated_run_count: usage.totals.estimated_count
    },
    by_provider: byProvider
  };
}

export async function recordUsageReconciliationStatement(args: {
  workspace_dir: string;
  statement_id?: string;
  provider: string;
  period_start: string;
  period_end: string;
  billed_cost_usd: number;
  billed_tokens?: number;
  currency?: "USD";
  source?: UsageReconciliationSource;
  external_ref?: string;
  notes?: string;
}): Promise<{
  workspace_dir: string;
  statement: UsageStatement;
}> {
  const startMs = parseIsoMs(args.period_start, "period_start");
  const endMs = parseIsoMs(args.period_end, "period_end");
  if (startMs === null || endMs === null) {
    throw new Error("period_start and period_end are required.");
  }
  if (endMs < startMs) {
    throw new Error("period_end must be greater than or equal to period_start.");
  }
  const statementId =
    args.statement_id?.trim() || `stmt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const statement = UsageStatement.parse({
    schema_version: 1,
    type: "usage_reconciliation_statement",
    statement_id: statementId,
    provider: args.provider.trim(),
    provider_key: normalizeProvider(args.provider),
    period_start: args.period_start,
    period_end: args.period_end,
    currency: args.currency ?? "USD",
    billed_cost_usd: args.billed_cost_usd,
    billed_tokens: args.billed_tokens,
    source: args.source ?? "manual",
    external_ref: args.external_ref?.trim() || undefined,
    notes: args.notes?.trim() || undefined,
    imported_at: nowIso()
  });

  const doc = await readStatementDoc(args.workspace_dir);
  const existingIndex = doc.statements.findIndex((row) => row.statement_id === statement.statement_id);
  if (existingIndex >= 0) {
    doc.statements[existingIndex] = statement;
  } else {
    doc.statements.push(statement);
  }
  await writeStatementDoc(args.workspace_dir, doc);
  return {
    workspace_dir: args.workspace_dir,
    statement
  };
}

export async function buildUsageReconciliationSnapshot(args: {
  workspace_dir: string;
  project_id?: string;
  period_start?: string;
  period_end?: string;
  internal_usage?: UsageAnalyticsSnapshot;
}): Promise<{
  workspace_dir: string;
  generated_at: string;
  project_id?: string;
  period_start?: string;
  period_end?: string;
  totals: {
    provider_count: number;
    internal_run_count: number;
    internal_tokens: number;
    internal_cost_usd: number;
    billed_line_count: number;
    billed_tokens: number;
    billed_tokens_known_line_count: number;
    billed_cost_usd: number;
    token_delta: number | null;
    cost_delta_usd: number;
  };
  coverage: {
    priced_run_count: number;
    unpriced_run_count: number;
    provider_reported_run_count: number;
    estimated_run_count: number;
  };
  by_provider: Array<{
    provider: string;
    internal_run_count: number;
    internal_tokens: number;
    internal_cost_usd: number;
    billed_line_count: number;
    billed_tokens: number | null;
    billed_cost_usd: number;
    token_delta: number | null;
    cost_delta_usd: number;
    cost_delta_pct: number | null;
  }>;
  statements: UsageStatement[];
}> {
  const startMs = parseIsoMs(args.period_start, "period_start");
  const endMs = parseIsoMs(args.period_end, "period_end");
  if (startMs !== null && endMs !== null && endMs < startMs) {
    throw new Error("period_end must be greater than or equal to period_start.");
  }
  const statementDoc = await readStatementDoc(args.workspace_dir);
  const statements = statementDoc.statements.filter((statement) => {
    const statementStartMs = Date.parse(statement.period_start);
    const statementEndMs = Date.parse(statement.period_end);
    if (!Number.isFinite(statementStartMs) || !Number.isFinite(statementEndMs)) return false;
    return overlapsWindow(statementStartMs, statementEndMs, startMs, endMs);
  });

  const internal =
    args.internal_usage != null
      ? collectInternalUsageFromAnalytics(args.internal_usage)
      : await collectInternalUsageFromRuns({
          workspace_dir: args.workspace_dir,
          project_id: args.project_id,
          period_start: args.period_start,
          period_end: args.period_end
        });

  const billedByProvider = new Map<
    string,
    { billed_line_count: number; billed_tokens: number; billed_tokens_known_line_count: number; billed_cost_usd: number }
  >();
  for (const statement of statements) {
    const providerKey = normalizeProvider(statement.provider_key || statement.provider);
    const entry =
      billedByProvider.get(providerKey) ??
      ({ billed_line_count: 0, billed_tokens: 0, billed_tokens_known_line_count: 0, billed_cost_usd: 0 } as const);
    const mutable = { ...entry };
    mutable.billed_line_count += 1;
    mutable.billed_cost_usd += statement.billed_cost_usd;
    if (statement.billed_tokens != null) {
      mutable.billed_tokens += statement.billed_tokens;
      mutable.billed_tokens_known_line_count += 1;
    }
    billedByProvider.set(providerKey, mutable);
  }

  const providers = new Set<string>([
    ...internal.by_provider.keys(),
    ...billedByProvider.keys()
  ]);
  const byProvider = [...providers]
    .map((provider) => {
      const internalEntry =
        internal.by_provider.get(provider) ??
        ({
          provider,
          run_count: 0,
          tokens: 0,
          cost_usd: 0
        } satisfies ProviderRollup);
      const billedEntry =
        billedByProvider.get(provider) ??
        ({ billed_line_count: 0, billed_tokens: 0, billed_tokens_known_line_count: 0, billed_cost_usd: 0 } as const);
      const billedTokens =
        billedEntry.billed_tokens_known_line_count > 0 ? billedEntry.billed_tokens : null;
      const tokenDelta = billedTokens == null ? null : billedTokens - internalEntry.tokens;
      const costDelta = billedEntry.billed_cost_usd - internalEntry.cost_usd;
      const costDeltaPct = internalEntry.cost_usd > 0 ? round6((costDelta / internalEntry.cost_usd) * 100) : null;
      return {
        provider,
        internal_run_count: internalEntry.run_count,
        internal_tokens: internalEntry.tokens,
        internal_cost_usd: round6(internalEntry.cost_usd),
        billed_line_count: billedEntry.billed_line_count,
        billed_tokens: billedTokens,
        billed_cost_usd: round6(billedEntry.billed_cost_usd),
        token_delta: tokenDelta,
        cost_delta_usd: round6(costDelta),
        cost_delta_pct: costDeltaPct
      };
    })
    .sort((a, b) => {
      const delta = Math.abs(b.cost_delta_usd) - Math.abs(a.cost_delta_usd);
      if (delta !== 0) return delta;
      return a.provider.localeCompare(b.provider);
    });

  const billedTokens = byProvider.reduce((sum, row) => sum + (row.billed_tokens ?? 0), 0);
  const billedTokensKnownLineCount = byProvider.reduce(
    (sum, row) => sum + (row.billed_tokens == null ? 0 : 1),
    0
  );
  const internalCost = byProvider.reduce((sum, row) => sum + row.internal_cost_usd, 0);
  const billedCost = byProvider.reduce((sum, row) => sum + row.billed_cost_usd, 0);

  return {
    workspace_dir: args.workspace_dir,
    generated_at: nowIso(),
    project_id: args.project_id,
    period_start: args.period_start,
    period_end: args.period_end,
    totals: {
      provider_count: byProvider.length,
      internal_run_count: internal.totals.run_count,
      internal_tokens: internal.totals.total_tokens,
      internal_cost_usd: round6(internalCost),
      billed_line_count: byProvider.reduce((sum, row) => sum + row.billed_line_count, 0),
      billed_tokens: billedTokens,
      billed_tokens_known_line_count: billedTokensKnownLineCount,
      billed_cost_usd: round6(billedCost),
      token_delta: billedTokensKnownLineCount > 0 ? billedTokens - internal.totals.total_tokens : null,
      cost_delta_usd: round6(billedCost - internalCost)
    },
    coverage: {
      priced_run_count: internal.totals.priced_run_count,
      unpriced_run_count: internal.totals.unpriced_run_count,
      provider_reported_run_count: internal.totals.provider_reported_run_count,
      estimated_run_count: internal.totals.estimated_run_count
    },
    by_provider: byProvider,
    statements
  };
}

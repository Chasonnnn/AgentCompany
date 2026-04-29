export type ProductivityWindow = "7d" | "30d" | "all";

export type ProductivityHealthStatus = "ok" | "watch" | "low_yield";

export interface ProductivityTotals {
  runCount: number;
  terminalRunCount: number;
  usefulRunCount: number;
  completedRunCount: number;
  blockedRunCount: number;
  lowYieldRunCount: number;
  planOnlyRunCount: number;
  emptyResponseRunCount: number;
  needsFollowupRunCount: number;
  failedRunCount: number;
  continuationExhaustionCount: number;
  completedIssueCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costCents: number;
  estimatedApiCostCents: number;
  durationMs: number;
  timeToFirstUsefulActionMs: number | null;
}

export interface ProductivityRatios {
  usefulRunRate: number;
  lowYieldRunRate: number;
  tokensPerUsefulRun: number | null;
  tokensPerCompletedIssue: number | null;
  avgRunDurationMs: number | null;
  avgTimeToFirstUsefulActionMs: number | null;
}

export interface LowYieldRunSummary {
  runId: string;
  agentId: string;
  agentName: string;
  issueId: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
  projectId: string | null;
  projectName: string | null;
  status: string;
  livenessState: string | null;
  livenessReason: string | null;
  continuationAttempt: number;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  totalTokens: number;
  estimatedApiCostCents: number;
  nextAction: string | null;
}

export interface AgentProductivitySummary {
  agentId: string;
  agentName: string;
  agentStatus: string;
  adapterType: string;
  role: string;
  archetypeKey: string | null;
  health: ProductivityHealthStatus;
  totals: ProductivityTotals;
  ratios: ProductivityRatios;
  lowYieldRuns: LowYieldRunSummary[];
}

export type ProductivityReviewHealthBadgeState = "ok" | "watch" | "review";

export interface ProductivityReviewMetadata {
  openReviewCount: number;
  mostRecentReviewAt: string | null;
  healthBadge: ProductivityReviewHealthBadgeState;
}

export interface ProductivitySummary {
  companyId: string;
  window: ProductivityWindow;
  generatedAt: string;
  from: string | null;
  totals: ProductivityTotals;
  ratios: ProductivityRatios;
  agents: AgentProductivitySummary[];
  lowYieldRuns: LowYieldRunSummary[];
  recommendations: string[];
  review?: ProductivityReviewMetadata;
}

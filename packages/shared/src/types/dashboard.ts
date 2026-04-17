import type { CompanyAgentCompositionSummary } from "./agent.js";

export interface DashboardSummary {
  companyId: string;
  agents: {
    active: number;
    running: number;
    paused: number;
    error: number;
    composition: CompanyAgentCompositionSummary;
  };
  tasks: {
    open: number;
    inProgress: number;
    blocked: number;
    done: number;
  };
  costs: {
    monthSpendCents: number;
    monthBudgetCents: number;
    monthUtilizationPercent: number;
  };
  pendingApprovals: number;
  decisionQuestions: {
    open: number;
    blocking: number;
    recent: Array<{
      id: string;
      issueId: string;
      issueIdentifier: string | null;
      issueTitle: string;
      title: string;
      blocking: boolean;
      createdAt: string;
    }>;
  };
  executionHealth: {
    activeContinuityOwners: number;
    blockedMissingDocs: number;
    staleProgress: number;
    invalidHandoff: number;
    openReviewFindings: number;
    returnedBranches: number;
    handoffPending: number;
  };
  budgets: {
    activeIncidents: number;
    pendingApprovals: number;
    pausedAgents: number;
    pausedProjects: number;
  };
}

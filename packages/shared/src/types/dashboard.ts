import type { ComputedAgentState } from "../computed-agent-state.js";
import type { CompanyAgentCompositionSummary } from "./agent.js";

export interface DashboardRunActivityDay {
  date: string;
  succeeded: number;
  failed: number;
  other: number;
  total: number;
}

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
    operatorStates: Array<{
      state: string;
      count: number;
    }>;
    computedAgentStates: Array<{
      state: ComputedAgentState;
      count: number;
      detailedStates: Array<{ state: string; count: number }>;
    }>;
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
  operatorStateReasons: Array<{
    state: string;
    reason: string;
    count: number;
  }>;
  budgets: {
    activeIncidents: number;
    pendingApprovals: number;
    pausedAgents: number;
    pausedProjects: number;
  };
  runActivity: DashboardRunActivityDay[];
}

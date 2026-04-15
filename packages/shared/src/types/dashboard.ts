export interface DashboardSummary {
  companyId: string;
  agents: {
    active: number;
    running: number;
    paused: number;
    error: number;
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

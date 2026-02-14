export type ScopeKind = "workspace" | "project";
export type ViewKind = "home" | "activities" | "resources" | "conversation";

export type ProjectSummary = {
  project_id: string;
  name: string;
  status: "active" | "archived";
  created_at: string;
  pending_reviews: number;
  active_runs: number;
  task_count: number;
  progress_pct: number;
  blocked_tasks: number;
  risk_flags: string[];
  repo_links?: Array<{
    repo_id: string;
    label?: string;
    linked_at?: string;
  }>;
};

export type AgentSummary = {
  agent_id: string;
  name: string;
  display_title?: string;
  avatar?: string;
  role: "ceo" | "director" | "manager" | "worker";
  provider: string;
  model_hint?: string;
  team_id?: string;
  created_at: string;
};

export type TeamSummary = {
  team_id: string;
  name: string;
  department_key?: string;
  department_label?: string;
  charter?: string;
  created_at: string;
};

export type ConversationSummary = {
  schema_version: number;
  type: "conversation";
  id: string;
  scope: ScopeKind;
  project_id?: string;
  kind: "home" | "channel" | "dm";
  name: string;
  slug: string;
  visibility: "private_agent" | "team" | "managers" | "org";
  created_at: string;
  created_by: string;
  auto_generated: boolean;
  participants: {
    agent_ids: string[];
    team_ids: string[];
  };
  dm_peer_agent_id?: string;
};

export type ConversationMessage = {
  schema_version: number;
  type: "message";
  id: string;
  conversation_id: string;
  project_id?: string;
  created_at: string;
  author_id: string;
  author_role: "human" | "ceo" | "director" | "manager" | "worker";
  kind: "text" | "system" | "report";
  visibility: "private_agent" | "team" | "managers" | "org";
  body: string;
  mentions: string[];
};

export type WorkspaceHomeSnapshot = {
  workspace_dir: string;
  generated_at: string;
  projects: Array<{
    project_id: string;
    name: string;
    status: "active" | "archived";
    created_at: string;
    repo_ids: string[];
    pending_reviews: number;
    active_runs: number;
    task_count: number;
    progress_pct: number;
    blocked_tasks: number;
    risk_flags: string[];
  }>;
  summary: {
    project_count: number;
    pending_reviews: number;
    active_runs: number;
    task_count: number;
    progress_pct: number;
    blocked_projects: number;
  };
};

export type PmSnapshot = {
  workspace_dir: string;
  generated_at: string;
  scope: ScopeKind;
  workspace: {
    summary: {
      project_count: number;
      active_runs: number;
      pending_reviews: number;
      total_tokens: number;
      progress_pct: number;
      blocked_projects: number;
    };
    projects: Array<{
      project_id: string;
      name: string;
      task_count: number;
      progress_pct: number;
      blocked_tasks: number;
      active_runs: number;
      pending_reviews: number;
      risk_flags: string[];
    }>;
  };
  project?: {
    project_id: string;
    summary: {
      task_count: number;
      done_tasks: number;
      blocked_tasks: number;
      in_progress_tasks: number;
      progress_pct: number;
    };
    gantt: {
      cpm_status: "ok" | "dependency_cycle";
      project_span_days: number;
      tasks: Array<{
        task_id: string;
        title: string;
        status: string;
        team_id?: string;
        assignee_agent_id?: string;
        progress_pct: number;
        start_at: string;
        end_at: string;
        duration_days: number;
        slack_days: number;
        critical: boolean;
        depends_on_task_ids: string[];
      }>;
    };
  };
};

export type AllocationRecommendation = {
  task_id: string;
  preferred_provider?: string;
  preferred_model?: string;
  preferred_agent_id?: string;
  token_budget_hint?: number;
  reason: string;
};

export type ResourcesSnapshot = {
  workspace_dir: string;
  generated_at: string;
  project_id?: string;
  totals: {
    agents: number;
    workers: number;
    active_workers: number;
    runs_indexed: number;
    total_tokens: number;
    total_cost_usd: number;
    context_cycles_total: number;
    context_cycles_known_runs: number;
    context_cycles_unknown_runs: number;
  };
  providers: Array<{
    provider: string;
    run_count: number;
    total_tokens: number;
    total_cost_usd: number;
  }>;
  models: Array<{
    model: string;
    agent_count: number;
  }>;
};

export type UiSnapshot = {
  workspace_dir: string;
  generated_at: string;
  heartbeat?: {
    enabled: boolean;
    running: boolean;
    tick_interval_minutes: number;
    top_k_workers: number;
    min_wake_score: number;
    hierarchy_mode: "standard" | "enterprise_v1";
    executive_manager_agent_id?: string;
    allow_director_to_spawn_workers: boolean;
    last_tick_at?: string;
    next_tick_at?: string;
    stats: {
      ticks_total: number;
      workers_woken_total: number;
      reports_ok_total: number;
      reports_actions_total: number;
      actions_executed_total: number;
      approvals_queued_total: number;
      deduped_actions_total: number;
    };
  };
  monitor: {
    rows: Array<{
      project_id: string;
      run_id: string;
      run_status: string;
      live_status: string;
      agent_id?: string;
      provider?: string;
      created_at?: string;
    }>;
  };
  review_inbox: {
    pending: Array<{
      project_id: string;
      artifact_id: string;
      artifact_type: string;
      title?: string;
      created_at?: string;
    }>;
    recent_decisions: Array<{
      review_id: string;
      project_id: string;
      decision: "approved" | "denied";
      created_at: string;
      actor_id: string;
      subject_artifact_id: string;
      notes?: string;
    }>;
  };
  usage_analytics?: {
    totals?: {
      total_tokens: number;
      total_cost_usd: number;
    };
  };
};

export type InboxSnapshot = {
  workspace_dir: string;
  generated_at: string;
  pending: Array<{
    project_id: string;
    artifact_id: string;
    artifact_type: string;
    title: string | null;
    visibility: string | null;
    produced_by: string | null;
    run_id: string | null;
    created_at: string | null;
    parse_error_count: number;
  }>;
  recent_decisions: Array<{
    review_id: string;
    created_at: string;
    decision: "approved" | "denied";
    actor_id: string;
    actor_role: string;
    subject_kind: string;
    subject_artifact_id: string;
    project_id: string;
    notes: string | null;
    artifact_type: string | null;
    run_id: string | null;
    parse_error_count: number;
  }>;
};

export type AgentProfileSnapshot = {
  workspace_dir: string;
  generated_at: string;
  agent: {
    agent_id: string;
    name: string;
    display_title?: string;
    avatar?: string;
    role: "ceo" | "director" | "manager" | "worker";
    provider: string;
    model_hint?: string;
    team_id?: string;
    created_at: string;
    tenure_days: number;
  };
  metrics: {
    total_runs: number;
    running_runs: number;
    ended_runs: number;
    failed_runs: number;
    stopped_runs: number;
    total_tokens: number;
    total_cost_usd: number;
    context_cycles_count: number | null;
    context_cycles_source: "provider_signal" | "unknown";
  };
};

export type ClientIntakeRunResult = {
  project_id: string;
  artifacts: {
    intake_brief_artifact_id: string;
    executive_plan_artifact_id: string;
    meeting_transcript_artifact_id: string;
    approval_artifact_id: string;
  };
  department_plan_artifact_ids: Record<string, string>;
  director_task_ids: Record<string, string>;
  assigned_task_ids: string[];
  meeting_conversation_id: string;
  generation: {
    mode: "deterministic" | "provider_with_fallback";
    attempted: number;
    succeeded: number;
    failed: number;
    failure_artifact_ids: string[];
    audit_log_relpath: string;
  };
};

export type DepartmentAssignResult = {
  project_id: string;
  department_key: string;
  director_agent_id: string;
  executive_plan_artifact_id: string;
  created_task_ids: string[];
  created_milestone_ids: string[];
  assignment_map: Record<string, string>;
  denied_assignments: Array<{
    worker_agent_id: string;
    reason: string;
    expected_team_id?: string;
    actual_team_id?: string;
  }>;
  audit_log_relpath: string;
};

export type BootstrapHomeViewData = {
  workspace_home: WorkspaceHomeSnapshot;
  pm: PmSnapshot;
  resources: ResourcesSnapshot;
  recommendations?: AllocationRecommendation[];
};

export type BootstrapConversationViewData = {
  messages: ConversationMessage[];
};

export type BootstrapActivitiesViewData = {
  ui: UiSnapshot;
};

export type BootstrapResourcesViewData = {
  resources: ResourcesSnapshot;
};

export type DesktopBootstrapSnapshot = {
  workspace_dir: string;
  actor_id: string;
  scope: ScopeKind;
  project_id?: string;
  view: ViewKind;
  conversation_id?: string;
  projects: ProjectSummary[];
  agents: AgentSummary[];
  teams: TeamSummary[];
  conversations: ConversationSummary[];
  view_data:
    | BootstrapHomeViewData
    | BootstrapConversationViewData
    | BootstrapActivitiesViewData
    | BootstrapResourcesViewData;
  resources_summary: ResourcesSnapshot["totals"];
  activity_summary: {
    pending_reviews: number;
    recent_decisions: number;
    monitor_rows: number;
  };
  pm_summary: {
    project_count: number;
    progress_pct: number;
    blocked_projects: number;
    active_runs: number;
    pending_reviews: number;
  };
  sync_ts: string;
};

export type AllocationApplyPayload = {
  task_id: string;
  preferred_provider?: string;
  preferred_model?: string;
  preferred_agent_id?: string;
  token_budget_hint?: number;
};

export type WorkspacePMViewModel = PmSnapshot["workspace"];
export type ProjectPMViewModel = NonNullable<PmSnapshot["project"]>;

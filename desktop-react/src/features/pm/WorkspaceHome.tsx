import { Panel } from "@/components/primitives/Panel";
import { Badge } from "@/components/primitives/Badge";
import { Button } from "@/components/primitives/Button";
import type {
  AgentSummary,
  PmSnapshot,
  ResourcesSnapshot,
  TeamSummary,
  WorkspaceHomeSnapshot
} from "@/types";
import { formatNumber, formatPercent, formatUsd } from "@/utils/format";

type Props = {
  workspaceHome: WorkspaceHomeSnapshot;
  pm: PmSnapshot;
  resources: ResourcesSnapshot;
  agents: AgentSummary[];
  teams: TeamSummary[];
  activitySummary?: {
    pending_reviews: number;
    recent_decisions: number;
    monitor_rows: number;
  };
  onOpenProject: (projectId: string) => void;
  onStartClientIntake?: () => void;
};

export function WorkspaceHome({
  workspaceHome,
  pm,
  resources,
  agents,
  teams,
  activitySummary,
  onOpenProject,
  onStartClientIntake
}: Props) {
  const executiveManager = agents.find((a) => a.role === "manager" && a.display_title === "Executive Manager");
  const directorsByTeam = new Map<string, number>();
  const workersByTeam = new Map<string, number>();
  for (const agent of agents) {
    if (!agent.team_id) continue;
    if (agent.role === "director") {
      directorsByTeam.set(agent.team_id, (directorsByTeam.get(agent.team_id) ?? 0) + 1);
    } else if (agent.role === "worker") {
      workersByTeam.set(agent.team_id, (workersByTeam.get(agent.team_id) ?? 0) + 1);
    }
  }

  return (
    <div className="stack">
      <section className="kpi-grid">
        <Kpi label="Projects" value={formatNumber(pm.workspace.summary.project_count)} meta="Portfolio total" />
        <Kpi label="Progress" value={formatPercent(pm.workspace.summary.progress_pct)} meta="Weighted average" />
        <Kpi
          label="Token Usage"
          value={formatNumber(resources.totals.total_tokens)}
          meta={`${formatUsd(resources.totals.total_cost_usd)} spend`}
        />
        <Kpi
          label="Ops Alerts"
          value={formatNumber(workspaceHome.summary.pending_reviews + workspaceHome.summary.blocked_projects)}
          meta={`${workspaceHome.summary.pending_reviews} pending reviews`}
        />
      </section>

      <Panel
        title="Executive Office"
        actions={
          onStartClientIntake ? (
            <Button tone="primary" onClick={onStartClientIntake}>
              Start Client Intake
            </Button>
          ) : undefined
        }
      >
        <div className="hstack" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div className="stack" style={{ gap: 6 }}>
            <div className="muted">Executive Manager</div>
            <strong>{executiveManager?.name ?? "Not configured"}</strong>
            <div className="muted">
              Pending approvals: {formatNumber(activitySummary?.pending_reviews ?? workspaceHome.summary.pending_reviews)}
            </div>
            <div className="muted">
              Active signals: {formatNumber(activitySummary?.monitor_rows ?? pm.workspace.summary.active_runs)}
            </div>
          </div>
          <div className="stack" style={{ gap: 6 }}>
            <Badge tone={workspaceHome.summary.blocked_projects > 0 ? "warn" : "default"}>
              Blocked projects: {formatNumber(workspaceHome.summary.blocked_projects)}
            </Badge>
            <Badge>Recent decisions: {formatNumber(activitySummary?.recent_decisions ?? 0)}</Badge>
            <Badge>Total agents: {formatNumber(agents.length)}</Badge>
          </div>
        </div>
      </Panel>

      <Panel title="Department Progress Board">
        <table className="table">
          <thead>
            <tr>
              <th>Department</th>
              <th>Directors</th>
              <th>Workers</th>
              <th>Charter</th>
            </tr>
          </thead>
          <tbody>
            {teams.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted">
                  No departments detected yet.
                </td>
              </tr>
            ) : (
              teams.map((team) => (
                <tr key={team.team_id}>
                  <td>{team.department_label ?? team.name}</td>
                  <td>{formatNumber(directorsByTeam.get(team.team_id) ?? 0)}</td>
                  <td>{formatNumber(workersByTeam.get(team.team_id) ?? 0)}</td>
                  <td>{team.charter ?? "No charter set"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Panel>

      <Panel title="Project Portfolio">
        <table className="table">
          <thead>
            <tr>
              <th>Project</th>
              <th>Progress</th>
              <th>Tasks</th>
              <th>Runs</th>
              <th>Reviews</th>
              <th>Risk</th>
            </tr>
          </thead>
          <tbody>
            {pm.workspace.projects.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  No projects yet. Use the + button in the left rail to create your first project.
                </td>
              </tr>
            ) : (
              pm.workspace.projects.map((project) => (
                <tr key={project.project_id}>
                  <td>
                    <button className="btn ghost" onClick={() => onOpenProject(project.project_id)}>
                      {project.name}
                    </button>
                  </td>
                  <td>{formatPercent(project.progress_pct)}</td>
                  <td>{formatNumber(project.task_count)}</td>
                  <td>{formatNumber(project.active_runs)}</td>
                  <td>{formatNumber(project.pending_reviews)}</td>
                  <td>
                    {project.risk_flags.length === 0 ? (
                      <Badge>Healthy</Badge>
                    ) : (
                      project.risk_flags.map((flag) => (
                        <Badge key={flag} tone={flag.includes("blocked") ? "danger" : "warn"}>
                          {flag}
                        </Badge>
                      ))
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

function Kpi({ label, value, meta }: { label: string; value: string; meta: string }) {
  return (
    <article className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-meta">{meta}</div>
    </article>
  );
}

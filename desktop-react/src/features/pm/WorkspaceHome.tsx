import { Panel } from "@/components/primitives/Panel";
import { Badge } from "@/components/primitives/Badge";
import type { PmSnapshot, ResourcesSnapshot, WorkspaceHomeSnapshot } from "@/types";
import { formatNumber, formatPercent, formatUsd } from "@/utils/format";

type Props = {
  workspaceHome: WorkspaceHomeSnapshot;
  pm: PmSnapshot;
  resources: ResourcesSnapshot;
  onOpenProject: (projectId: string) => void;
};

export function WorkspaceHome({ workspaceHome, pm, resources, onOpenProject }: Props) {
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
            {pm.workspace.projects.map((project) => (
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
            ))}
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


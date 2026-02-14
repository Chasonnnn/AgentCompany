import { Panel } from "@/components/primitives/Panel";
import { Button } from "@/components/primitives/Button";
import { Badge } from "@/components/primitives/Badge";
import { EmptyState } from "@/components/primitives/EmptyState";
import { Gantt } from "./Gantt";
import type { AllocationRecommendation, AllocationApplyPayload, ProjectPMViewModel, ResourcesSnapshot } from "@/types";
import { formatNumber, formatPercent, formatUsd } from "@/utils/format";

type Props = {
  projectPm: ProjectPMViewModel;
  resources: ResourcesSnapshot;
  recommendations: AllocationRecommendation[];
  applying: boolean;
  assigningDepartmentTasks?: boolean;
  onApplyOne: (item: AllocationApplyPayload) => Promise<void>;
  onApplyAll: (items: AllocationApplyPayload[]) => Promise<void>;
  onAssignDepartmentTasks?: (approvedExecutivePlanArtifactId: string) => Promise<void>;
};

export function ProjectHome({
  projectPm,
  resources,
  recommendations,
  applying,
  assigningDepartmentTasks,
  onApplyOne,
  onApplyAll,
  onAssignDepartmentTasks
}: Props) {
  const allItems: AllocationApplyPayload[] = recommendations.map((row) => ({
    task_id: row.task_id,
    preferred_provider: row.preferred_provider,
    preferred_model: row.preferred_model,
    preferred_agent_id: row.preferred_agent_id,
    token_budget_hint: row.token_budget_hint
  }));

  return (
    <div className="stack">
      <section className="kpi-grid">
        <Kpi label="Tasks" value={formatNumber(projectPm.summary.task_count)} meta="Planned tasks" />
        <Kpi label="Progress" value={formatPercent(projectPm.summary.progress_pct)} meta="Milestone rollup" />
        <Kpi label="Blocked" value={formatNumber(projectPm.summary.blocked_tasks)} meta="Requires intervention" />
        <Kpi
          label="Usage"
          value={formatNumber(resources.totals.total_tokens)}
          meta={`${formatUsd(resources.totals.total_cost_usd)} for project`}
        />
      </section>

      <Panel title="CPM / Gantt">
        <Gantt gantt={projectPm.gantt} />
      </Panel>

      <Panel title="Planning Council">
        <div className="stack" style={{ gap: 8 }}>
          <div className="muted">
            Review planning transcript/department plans and approve the executive plan before worker execution.
          </div>
          {onAssignDepartmentTasks ? (
            <Button
              tone="primary"
              disabled={Boolean(assigningDepartmentTasks)}
              onClick={() => {
                const id = window.prompt("Approved executive plan artifact id");
                if (!id?.trim()) return;
                void onAssignDepartmentTasks(id.trim());
              }}
            >
              {assigningDepartmentTasks ? "Assigning..." : "Run Department Assignment"}
            </Button>
          ) : null}
        </div>
      </Panel>

      <Panel
        title="Allocation Recommendations"
        actions={
          <Button
            tone="primary"
            disabled={applying || allItems.length === 0}
            onClick={() => onApplyAll(allItems)}
          >
            {applying ? "Applying..." : "Apply All"}
          </Button>
        }
      >
        {recommendations.length === 0 ? (
          <EmptyState message="No allocation recommendations available for current task state." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Provider</th>
                <th>Model</th>
                <th>Agent</th>
                <th>Budget</th>
                <th>Reason</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {recommendations.map((row) => (
                <tr key={row.task_id}>
                  <td>{row.task_id}</td>
                  <td>{row.preferred_provider ?? "auto"}</td>
                  <td>{row.preferred_model ?? "auto"}</td>
                  <td>{row.preferred_agent_id ?? "auto"}</td>
                  <td>{row.token_budget_hint ? formatNumber(row.token_budget_hint) : "auto"}</td>
                  <td>
                    <Badge>{row.reason}</Badge>
                  </td>
                  <td>
                    <Button
                      onClick={() =>
                        onApplyOne({
                          task_id: row.task_id,
                          preferred_provider: row.preferred_provider,
                          preferred_model: row.preferred_model,
                          preferred_agent_id: row.preferred_agent_id,
                          token_budget_hint: row.token_budget_hint
                        })
                      }
                    >
                      Apply
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
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

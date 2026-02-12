import { Panel } from "@/components/primitives/Panel";
import type { ResourcesSnapshot } from "@/types";
import { formatNumber, formatUsd } from "@/utils/format";

export function ResourcesView({ resources }: { resources: ResourcesSnapshot }) {
  return (
    <div className="stack">
      <section className="kpi-grid">
        <Kpi label="Agents" value={formatNumber(resources.totals.agents)} meta="Registered workers/managers" />
        <Kpi label="Active Workers" value={formatNumber(resources.totals.active_workers)} meta="Currently running" />
        <Kpi
          label="Total Tokens"
          value={formatNumber(resources.totals.total_tokens)}
          meta={`${formatUsd(resources.totals.total_cost_usd)} total cost`}
        />
        <Kpi
          label="Context Cycles"
          value={formatNumber(resources.totals.context_cycles_total)}
          meta={`${resources.totals.context_cycles_unknown_runs} runs unknown`}
        />
      </section>

      <Panel title="Provider Usage">
        <table className="table">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Runs</th>
              <th>Tokens</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {resources.providers.map((row) => (
              <tr key={row.provider}>
                <td>{row.provider}</td>
                <td>{formatNumber(row.run_count)}</td>
                <td>{formatNumber(row.total_tokens)}</td>
                <td>{formatUsd(row.total_cost_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Model Distribution">
        <table className="table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Agents</th>
            </tr>
          </thead>
          <tbody>
            {resources.models.map((row) => (
              <tr key={row.model}>
                <td>{row.model}</td>
                <td>{formatNumber(row.agent_count)}</td>
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


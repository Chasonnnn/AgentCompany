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

      <Panel title="Invoice Reconciliation">
        <div className="kpi-grid" style={{ marginBottom: 10 }}>
          <Kpi
            label="Internal Cost"
            value={formatUsd(resources.reconciliation.totals.internal_cost_usd)}
            meta={`${formatNumber(resources.reconciliation.coverage.priced_run_count)} priced runs`}
          />
          <Kpi
            label="Billed Cost"
            value={formatUsd(resources.reconciliation.totals.billed_cost_usd)}
            meta={`${formatNumber(resources.reconciliation.totals.billed_line_count)} statement lines`}
          />
          <Kpi
            label="Cost Delta"
            value={formatUsd(resources.reconciliation.totals.cost_delta_usd)}
            meta="billed - internal"
          />
          <Kpi
            label="Token Delta"
            value={
              resources.reconciliation.totals.token_delta == null
                ? "N/A"
                : formatNumber(resources.reconciliation.totals.token_delta)
            }
            meta="billed - internal"
          />
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Internal Cost</th>
              <th>Billed Cost</th>
              <th>Cost Delta</th>
              <th>Internal Tokens</th>
              <th>Billed Tokens</th>
              <th>Token Delta</th>
            </tr>
          </thead>
          <tbody>
            {resources.reconciliation.by_provider.length === 0 ? (
              <tr>
                <td colSpan={7} className="muted">
                  No billing statements recorded yet. Add statements through `usage.reconciliation.record`.
                </td>
              </tr>
            ) : (
              resources.reconciliation.by_provider.map((row) => (
                <tr key={row.provider}>
                  <td>{row.provider}</td>
                  <td>{formatUsd(row.internal_cost_usd)}</td>
                  <td>{formatUsd(row.billed_cost_usd)}</td>
                  <td>{formatUsd(row.cost_delta_usd)}</td>
                  <td>{formatNumber(row.internal_tokens)}</td>
                  <td>{row.billed_tokens == null ? "N/A" : formatNumber(row.billed_tokens)}</td>
                  <td>{row.token_delta == null ? "N/A" : formatNumber(row.token_delta)}</td>
                </tr>
              ))
            )}
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

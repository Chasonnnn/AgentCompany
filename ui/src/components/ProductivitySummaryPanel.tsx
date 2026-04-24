import type { AgentProductivitySummary, LowYieldRunSummary, ProductivityRatios, ProductivityTotals } from "@paperclipai/shared";
import { formatCents, formatDateTime, formatTokens } from "../lib/utils";

function formatRate(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatDuration(ms: number | null) {
  if (ms == null) return "n/a";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

function Metric({ label, value, subtext }: { label: string; value: string; subtext: string }) {
  return (
    <div className="border border-border p-4">
      <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">{label}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-xs leading-5 text-muted-foreground">{subtext}</div>
    </div>
  );
}

export function ProductivityMetricGrid({ totals, ratios }: { totals: ProductivityTotals; ratios: ProductivityRatios }) {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <Metric
        label="Useful Runs"
        value={formatRate(ratios.usefulRunRate)}
        subtext={`${totals.usefulRunCount}/${totals.terminalRunCount} terminal runs moved, finished, or blocked clearly`}
      />
      <Metric
        label="Low Yield"
        value={formatRate(ratios.lowYieldRunRate)}
        subtext={`${totals.lowYieldRunCount} plan-only, empty, or follow-up-only runs`}
      />
      <Metric
        label="Tokens / Useful"
        value={ratios.tokensPerUsefulRun == null ? "n/a" : formatTokens(ratios.tokensPerUsefulRun)}
        subtext={`${formatTokens(totals.totalTokens)} total tokens, ${formatCents(totals.estimatedApiCostCents)} API-equivalent`}
      />
      <Metric
        label="First Action"
        value={formatDuration(ratios.avgTimeToFirstUsefulActionMs)}
        subtext={`${totals.continuationExhaustionCount} exhausted continuation${totals.continuationExhaustionCount === 1 ? "" : "s"}`}
      />
    </div>
  );
}

export function AgentProductivityTable({ agents }: { agents: AgentProductivitySummary[] }) {
  if (agents.length === 0) {
    return <p className="text-sm text-muted-foreground">No agent runs in this window.</p>;
  }
  return (
    <div className="overflow-x-auto border border-border">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-border bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Agent</th>
            <th className="px-3 py-2 font-medium">Health</th>
            <th className="px-3 py-2 font-medium">Useful</th>
            <th className="px-3 py-2 font-medium">Low yield</th>
            <th className="px-3 py-2 font-medium">Tokens/useful</th>
            <th className="px-3 py-2 font-medium">Runs</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => (
            <tr key={agent.agentId} className="border-b border-border/60 last:border-0">
              <td className="px-3 py-2">
                <div className="font-medium">{agent.agentName}</div>
                <div className="text-xs text-muted-foreground">{agent.role} / {agent.adapterType}</div>
              </td>
              <td className="px-3 py-2">
                <span className="rounded border border-border px-2 py-1 text-xs capitalize">{agent.health.replace("_", " ")}</span>
              </td>
              <td className="px-3 py-2 tabular-nums">{formatRate(agent.ratios.usefulRunRate)}</td>
              <td className="px-3 py-2 tabular-nums">{agent.totals.lowYieldRunCount}</td>
              <td className="px-3 py-2 tabular-nums">
                {agent.ratios.tokensPerUsefulRun == null ? "n/a" : formatTokens(agent.ratios.tokensPerUsefulRun)}
              </td>
              <td className="px-3 py-2 tabular-nums">{agent.totals.runCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LowYieldRunList({ runs }: { runs: LowYieldRunSummary[] }) {
  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">No low-yield runs in this window.</p>;
  }
  return (
    <div className="space-y-2">
      {runs.map((run) => (
        <div key={run.runId} className="border border-border p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">
                {run.issueIdentifier ?? "Unlinked run"}{run.issueTitle ? ` / ${run.issueTitle}` : ""}
              </div>
              <div className="text-xs text-muted-foreground">
                {run.agentName} / {run.livenessState ?? "unknown"} / {run.startedAt ? formatDateTime(run.startedAt) : "not started"}
              </div>
            </div>
            <div className="text-right text-xs text-muted-foreground tabular-nums">
              <div>{formatTokens(run.totalTokens)} tok</div>
              <div>{formatDuration(run.durationMs)}</div>
            </div>
          </div>
          {run.livenessReason && <p className="mt-2 text-xs text-muted-foreground">{run.livenessReason}</p>}
          {run.nextAction && <p className="mt-1 text-xs">Next: {run.nextAction}</p>}
        </div>
      ))}
    </div>
  );
}

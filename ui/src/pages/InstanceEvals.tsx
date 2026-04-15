import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  EvalDimension,
  EvalRunArtifact,
  EvalRunListItem,
  EvalRunStatus,
  EvalSummaryIndex,
  EvalSummaryScenarioEntry,
} from "@paperclipai/shared";
import { ActivitySquare, AlertTriangle, BarChart3, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link, useParams } from "@/lib/router";
import { evalsApi } from "@/api/evals";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";

function statusTone(status: EvalRunStatus) {
  switch (status) {
    case "passed":
      return "default";
    case "failed":
    case "invalid":
      return "destructive";
    case "flaky":
    case "timed_out":
    case "blocked":
      return "secondary";
  }
}

function findDimension(summary: EvalSummaryIndex, dimension: EvalDimension) {
  return summary.dimensions.find((entry) => entry.dimension === dimension) ?? null;
}

function RunStatusBadge({ status }: { status: EvalRunStatus }) {
  return (
    <Badge variant={statusTone(status)} className="capitalize">
      {status.replace(/_/g, " ")}
    </Badge>
  );
}

function sourceLabel(sourceKind: "seeded" | "observed") {
  return sourceKind === "observed" ? "Observed" : "Seeded";
}

function RunDetail({ run }: { run: EvalRunArtifact }) {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <ActivitySquare className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{run.scenario.title}</h1>
          <RunStatusBadge status={run.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          {run.bundle.label} • {run.scenario.dimension} / {run.scenario.layer}
        </p>
      </div>

      <section className="rounded-xl border border-border bg-card p-5 space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold">Replay envelope</h2>
            <p className="text-sm text-muted-foreground">
              Raw artifact bundle is read-only in Wave 1. This view is redacted by default.
            </p>
          </div>
          <Badge variant="outline">{run.redactionMode}</Badge>
        </div>
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Run</dt>
            <dd className="mt-1 text-sm font-medium">{run.runId}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Git SHA</dt>
            <dd className="mt-1 text-sm font-medium">{run.environment.gitSha}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Bundle</dt>
            <dd className="mt-1 text-sm">{run.bundle.label}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Source</dt>
            <dd className="mt-1 text-sm">{sourceLabel(run.sourceKind)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Seed</dt>
            <dd className="mt-1 text-sm">{run.environment.seed}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Started</dt>
            <dd className="mt-1 text-sm">{run.startedAt}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Completed</dt>
            <dd className="mt-1 text-sm">{run.completedAt}</dd>
          </div>
        </dl>
        {run.sourceKind === "observed" && run.observedRun ? (
          <dl className="grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Observed Issue</dt>
              <dd className="mt-1 text-sm">{run.observedRun.issueId ?? "none"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Heartbeat Run</dt>
              <dd className="mt-1 text-sm">{run.observedRun.heartbeatRunId ?? "none"}</dd>
            </div>
          </dl>
        ) : null}
      </section>

      <section className="rounded-xl border border-border bg-card p-5 space-y-3">
        <h2 className="text-sm font-semibold">Scorecard</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg border border-border/70 bg-background px-3 py-3">
            <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Accepted Outcome</p>
            <p className="mt-2 text-2xl font-semibold">{run.scorecard.acceptedOutcome ? "Yes" : "No"}</p>
          </div>
          <div className="rounded-lg border border-border/70 bg-background px-3 py-3">
            <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Manager Touches</p>
            <p className="mt-2 text-2xl font-semibold">{run.scorecard.managerTouches}</p>
          </div>
          <div className="rounded-lg border border-border/70 bg-background px-3 py-3">
            <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Token Cost</p>
            <p className="mt-2 text-2xl font-semibold">{run.scorecard.coordinationTax.tokenCost}</p>
          </div>
          <div className="rounded-lg border border-border/70 bg-background px-3 py-3">
            <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Approval Wait</p>
            <p className="mt-2 text-2xl font-semibold">{run.scorecard.coordinationTax.approvalWaitMinutes}m</p>
          </div>
        </div>
        <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-3">
          <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Acceptance rationale</p>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-sm">
            {run.scorecard.acceptance.rationale.map((reason: string) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5 space-y-3">
        <h2 className="text-sm font-semibold">Captured artifacts</h2>
        <ul className="space-y-2">
          {run.capturedArtifacts.map((artifact) => (
            <li key={artifact.relativePath} className="rounded-lg border border-border/70 bg-background px-3 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{artifact.label}</Badge>
                <Badge variant="secondary">{artifact.kind}</Badge>
              </div>
              <code className="mt-2 block text-xs text-muted-foreground">{artifact.relativePath}</code>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export function InstanceEvals() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { runId } = useParams<{ runId?: string }>();
  const [sourceFilter, setSourceFilter] = useState<"all" | "seeded" | "observed">("all");

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance Settings", href: "/instance/settings/general" },
      { label: "Architecture Evals", href: "/instance/settings/evals" },
      ...(runId ? [{ label: runId }] : []),
    ]);
  }, [runId, setBreadcrumbs]);

  const summaryQuery = useQuery({
    queryKey: queryKeys.instance.evalsSummary,
    queryFn: () => evalsApi.getSummary(),
  });

  const runsQuery = useQuery({
    queryKey: queryKeys.instance.evalRuns,
    queryFn: () => evalsApi.listRuns(),
  });

  const runQuery = useQuery({
    queryKey: runId ? queryKeys.instance.evalRun(runId) : ["instance", "eval-run", "missing"],
    queryFn: () => evalsApi.getRun(runId!),
    enabled: Boolean(runId),
  });

  const summary = summaryQuery.data ?? null;
  const recentRuns = runsQuery.data ?? [];
  const filteredRuns = useMemo(
    () => recentRuns.filter((run) => sourceFilter === "all" || run.sourceKind === sourceFilter),
    [recentRuns, sourceFilter],
  );
  const observedCount = recentRuns.filter((run) => run.sourceKind === "observed").length;
  const seededCount = recentRuns.filter((run) => run.sourceKind === "seeded").length;

  if (summaryQuery.isLoading || runsQuery.isLoading || (runId && runQuery.isLoading)) {
    return <div className="text-sm text-muted-foreground">Loading architecture evals...</div>;
  }

  if (summaryQuery.error || runsQuery.error || runQuery.error) {
    const error = summaryQuery.error ?? runsQuery.error ?? runQuery.error;
    return (
      <div className="text-sm text-destructive">
        {error instanceof Error ? error.message : "Failed to load architecture evals."}
      </div>
    );
  }

  if (runId && runQuery.data) {
    return (
      <div className="max-w-5xl space-y-4">
        <Link to="/instance/settings/evals" className="inline-flex text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground">
          Back to architecture evals
        </Link>
        <RunDetail run={runQuery.data} />
      </div>
    );
  }

  if (runId && !runQuery.data) {
    return (
      <div className="max-w-3xl space-y-3">
        <Link to="/instance/settings/evals" className="inline-flex text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground">
          Back to architecture evals
        </Link>
        <div className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
          Eval run not found.
        </div>
      </div>
    );
  }

  if (!summary) {
    return <div className="text-sm text-muted-foreground">No architecture eval summary available yet.</div>;
  }

  const reliability = findDimension(summary, "reliability");
  const stability = findDimension(summary, "stability");
  const utility = findDimension(summary, "utility");

  return (
    <div className="max-w-6xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Architecture Evals</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Internal-only, artifact-backed architecture evals. Raw artifacts remain the source of truth; this page reads the rebuildable summary index.
        </p>
      </div>

      <section className="grid gap-4 lg:grid-cols-4">
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Runs</p>
          <p className="mt-3 text-3xl font-semibold">{summary.runCount}</p>
          <p className="mt-2 text-sm text-muted-foreground">Latest run: {summary.latestRunId ?? "none"}</p>
        </div>
        {[
          { title: "Reliability", value: reliability?.totalRuns ?? 0, accepted: reliability?.acceptedOutcomes ?? 0 },
          { title: "Stability", value: stability?.totalRuns ?? 0, accepted: stability?.acceptedOutcomes ?? 0 },
          { title: "Utility", value: utility?.totalRuns ?? 0, accepted: utility?.acceptedOutcomes ?? 0 },
        ].map((entry) => (
          <div key={entry.title} className="rounded-xl border border-border bg-card p-5">
            <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">{entry.title}</p>
            <p className="mt-3 text-3xl font-semibold">{entry.value}</p>
            <p className="mt-2 text-sm text-muted-foreground">Accepted outcomes: {entry.accepted}</p>
          </div>
        ))}
      </section>

      <section className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Run sources</h2>
            <p className="text-sm text-muted-foreground">
              Seeded scenarios and observed continuity traces share the same artifact root.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {[
              { value: "all", label: `All (${recentRuns.length})` },
              { value: "seeded", label: `Seeded (${seededCount})` },
              { value: "observed", label: `Observed (${observedCount})` },
            ].map((option) => (
              <Button
                key={option.value}
                size="sm"
                variant={sourceFilter === option.value ? "default" : "outline"}
                onClick={() => setSourceFilter(option.value as typeof sourceFilter)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Failing scenarios</h2>
        </div>
        {summary.failingScenarios.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No failing scenarios in the current summary index.
          </p>
        ) : (
          <ul className="space-y-2">
            {summary.failingScenarios.map((scenario: EvalSummaryScenarioEntry) => (
              <li key={scenario.scenarioId} className="rounded-lg border border-border/70 bg-background px-3 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{scenario.title}</span>
                  {scenario.latestStatus ? <RunStatusBadge status={scenario.latestStatus} /> : null}
                </div>
                {scenario.latestRunId ? (
                  <Link to={`/instance/settings/evals/${scenario.latestRunId}`} className="mt-2 inline-flex text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground">
                    Open latest run
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Recent runs</h2>
        </div>
        {filteredRuns.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/70 bg-muted/10 px-4 py-4 text-sm text-muted-foreground">
            No architecture eval artifacts found yet. Run <code>pnpm evals:architecture:canary</code> and then <code>pnpm evals:architecture:rebuild</code>.
          </div>
        ) : (
          <ul className="space-y-2">
            {filteredRuns.map((run: EvalRunListItem) => (
              <li key={run.runId} className="rounded-lg border border-border/70 bg-background px-4 py-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{run.scenarioTitle}</span>
                      <RunStatusBadge status={run.status} />
                      <Badge variant="outline">{run.dimension}</Badge>
                      <Badge variant="secondary">{run.layer}</Badge>
                      <Badge variant="secondary">{sourceLabel(run.sourceKind)}</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {run.bundleLabel} • completed {run.completedAt}
                    </p>
                  </div>
                  <Link to={`/instance/settings/evals/${run.runId}`} className="inline-flex text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground">
                    Open run
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

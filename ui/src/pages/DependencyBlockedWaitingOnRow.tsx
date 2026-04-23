import { Link } from "@/lib/router";
import type { DashboardSummary } from "@paperclipai/shared";

export function DependencyBlockedWaitingOnRow({
  entries,
}: {
  entries: DashboardSummary["tasks"]["computedAgentStates"];
}) {
  const dependencyBlocked = entries.find((entry) => entry.state === "dependency_blocked");
  const waitingOn = dependencyBlocked?.waitingOn ?? [];
  if (waitingOn.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" data-testid="computed-agent-state-waiting-on">
      <span className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
        Waiting on
      </span>
      {waitingOn.map((entry) => {
        const label = entry.identifier ?? entry.issueId.slice(0, 8);
        const detail = entry.openChildCount > 0
          ? `${entry.openChildCount} open child${entry.openChildCount === 1 ? "" : "ren"}`
          : null;
        const dependentLabel = entry.dependentCount > 1
          ? `${entry.dependentCount} dependents`
          : null;
        const parts = [detail, dependentLabel].filter((x): x is string => !!x);
        return (
          <Link
            key={entry.issueId}
            to={`/issues/${entry.identifier ?? entry.issueId}`}
            className="inline-flex items-center gap-1 rounded-full border border-purple-500/30 bg-purple-500/10 px-2.5 py-0.5 font-mono text-[11px] text-purple-900 no-underline hover:bg-purple-500/20 dark:text-purple-100"
          >
            <span className="font-medium">{label}</span>
            {parts.length > 0 ? (
              <span className="font-sans text-[10px] opacity-70">({parts.join(" · ")})</span>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}

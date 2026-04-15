import type { Issue } from "@paperclipai/shared";
import { cn } from "../lib/utils";

type ContinuitySignal = {
  label: string;
  tone: "default" | "success" | "warning" | "danger" | "info";
};

function issueContinuitySignals(issue: Issue): ContinuitySignal[] {
  const summary = issue.continuitySummary ?? null;
  if (!summary) return [];

  const signals: ContinuitySignal[] = [];

  if (summary.health === "missing_required_docs") {
    signals.push({ label: "Missing docs", tone: "warning" });
  } else if (summary.health === "invalid_handoff") {
    signals.push({ label: "Invalid handoff", tone: "danger" });
  } else if (summary.health === "stale_progress") {
    signals.push({ label: "Stale progress", tone: "warning" });
  } else if (summary.status === "ready") {
    signals.push({ label: "Ready", tone: "success" });
  } else if (summary.status === "active") {
    signals.push({ label: "Active", tone: "success" });
  } else if (summary.status === "handoff_pending") {
    signals.push({ label: "Handoff pending", tone: "info" });
  }

  if (summary.activeGatePresent) {
    signals.push({ label: "In gate", tone: "info" });
  }
  if (summary.openReviewFindings) {
    signals.push({ label: "Findings", tone: "warning" });
  }
  if (summary.returnedBranchCount > 0) {
    signals.push({
      label: summary.returnedBranchCount === 1 ? "1 return" : `${summary.returnedBranchCount} returns`,
      tone: "info",
    });
  }

  return signals.slice(0, 3);
}

function toneClass(tone: ContinuitySignal["tone"]) {
  switch (tone) {
    case "success":
      return "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "warning":
      return "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "danger":
      return "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300";
    case "info":
      return "border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-300";
    default:
      return "border-border/70 bg-muted/50 text-muted-foreground";
  }
}

export function IssueContinuityBadge({
  issue,
  className,
}: {
  issue: Issue;
  className?: string;
}) {
  const signals = issueContinuitySignals(issue);
  if (signals.length === 0) return null;

  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)}>
      {signals.map((signal) => (
        <span
          key={signal.label}
          className={cn(
            "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
            toneClass(signal.tone),
          )}
        >
          {signal.label}
        </span>
      ))}
    </span>
  );
}

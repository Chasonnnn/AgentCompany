import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { EmptyState } from "@/components/primitives/EmptyState";
import type { UiSnapshot } from "@/types";
import { formatDateTime } from "@/utils/format";

type ActivityRow = {
  id: string;
  kind: "pending_review" | "decision" | "run" | "heartbeat_stop";
  title: string;
  meta: string;
  time: string;
};

type Props = {
  ui: UiSnapshot;
};

export function ActivitiesView({ ui }: Props) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const rows = useMemo<ActivityRow[]>(() => {
    const out: ActivityRow[] = [];
    for (const pending of ui.review_inbox.pending) {
      const isHeartbeatStop =
        pending.artifact_type === "heartbeat_action_proposal" &&
        (pending.title?.toLowerCase().includes("hard stop") ?? false);
      out.push({
        id: `pending:${pending.artifact_id}`,
        kind: isHeartbeatStop ? "heartbeat_stop" : "pending_review",
        title: pending.title || pending.artifact_type,
        meta: isHeartbeatStop
          ? `${pending.project_id} · heartbeat hard stop`
          : `${pending.project_id} · pending approval`,
        time: pending.created_at ?? ui.generated_at
      });
    }
    for (const decision of ui.review_inbox.recent_decisions) {
      out.push({
        id: `decision:${decision.review_id}`,
        kind: "decision",
        title: `${decision.decision.toUpperCase()} ${decision.subject_artifact_id}`,
        meta: `${decision.project_id} · by ${decision.actor_id}`,
        time: decision.created_at
      });
    }
    for (const run of ui.monitor.rows) {
      out.push({
        id: `run:${run.run_id}`,
        kind: "run",
        title: `Run ${run.run_id}`,
        meta: `${run.project_id} · ${run.run_status}`,
        time: run.created_at ?? ui.generated_at
      });
    }
    out.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
    return out;
  }, [ui]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 56,
    overscan: 10
  });

  if (rows.length === 0) return <EmptyState message="No activities in this scope." />;

  return (
    <section ref={parentRef} style={{ minHeight: 0, overflow: "auto" }}>
      <div style={{ position: "relative", height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          return (
            <article
              key={row.id}
              className="timeline-item"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${item.start}px)`
              }}
            >
              <div className="hstack" style={{ justifyContent: "space-between" }}>
                <strong style={{ fontSize: 13 }}>{row.title}</strong>
                <span className="timeline-meta">{formatDateTime(row.time)}</span>
              </div>
              <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                {row.meta}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

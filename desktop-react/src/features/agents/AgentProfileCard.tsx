import { Badge } from "@/components/primitives/Badge";
import { Button } from "@/components/primitives/Button";
import { EmptyState } from "@/components/primitives/EmptyState";
import type { AgentProfileSnapshot } from "@/types";
import { displayRole, formatNumber, formatUsd } from "@/utils/format";

type Props = {
  profile?: AgentProfileSnapshot;
  loading?: boolean;
  onQuickDm?: (agentId: string) => void;
};

export function AgentProfileCard({ profile, loading = false, onQuickDm }: Props) {
  if (loading) {
    return <EmptyState message="Loading profile..." compact />;
  }
  if (!profile) {
    return <EmptyState message="Select a participant to view profile details." compact />;
  }

  return (
    <article className="agent-card">
      <div className="hstack" style={{ justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{profile.agent.name}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            {profile.agent.display_title ?? displayRole(profile.agent.role)}
          </div>
        </div>
        <Badge>{profile.agent.provider}</Badge>
      </div>

      <div className="split">
        <Metric label="Model" value={profile.agent.model_hint ?? "Default"} />
        <Metric label="Tenure" value={`${formatNumber(profile.agent.tenure_days)} days`} />
        <Metric label="Runs" value={formatNumber(profile.metrics.total_runs)} />
        <Metric label="Tokens" value={formatNumber(profile.metrics.total_tokens)} />
        <Metric label="Cost" value={formatUsd(profile.metrics.total_cost_usd)} />
        <Metric
          label="Cycles"
          value={
            profile.metrics.context_cycles_source === "provider_signal" &&
            profile.metrics.context_cycles_count !== null
              ? formatNumber(profile.metrics.context_cycles_count)
              : "Unknown"
          }
        />
      </div>

      {onQuickDm ? (
        <Button tone="primary" onClick={() => onQuickDm(profile.agent.agent_id)}>
          Message
        </Button>
      ) : null}
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: "1px solid var(--border-subtle)", borderRadius: 8, padding: 8 }}>
      <div className="muted" style={{ fontSize: 11 }}>
        {label}
      </div>
      <div style={{ marginTop: 4, fontSize: 13, fontWeight: 640 }}>{value}</div>
    </div>
  );
}

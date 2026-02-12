import { ListRow } from "@/components/primitives/ListRow";
import { EmptyState } from "@/components/primitives/EmptyState";
import { AgentProfileCard } from "@/features/agents/AgentProfileCard";
import type { AgentProfileSnapshot, AgentSummary } from "@/types";

type Props = {
  participants: AgentSummary[];
  selectedAgentId?: string;
  onSelectAgent: (agentId: string) => void;
  profile?: AgentProfileSnapshot;
  loadingProfile: boolean;
  hasConversation: boolean;
  onQuickDm: (agentId: string) => void;
};

export function DetailsPane({
  participants,
  selectedAgentId,
  onSelectAgent,
  profile,
  loadingProfile,
  hasConversation,
  onQuickDm
}: Props) {
  if (!hasConversation) {
    return (
      <aside className="pane details-pane">
        <header className="details-header">
          <h3>Participants</h3>
        </header>
        <div className="details-content">
          <EmptyState message="Open a channel or DM to view participants and profiles." compact />
        </div>
      </aside>
    );
  }

  return (
    <aside className="pane details-pane">
      <header className="details-header">
        <h3>Participants</h3>
      </header>

      <div className="details-content stack">
        <section className="stack">
          {participants.length === 0 ? (
            <EmptyState message="No participants." compact />
          ) : (
            participants.map((agent) => (
              <ListRow
                key={agent.agent_id}
                active={selectedAgentId === agent.agent_id}
                onClick={() => onSelectAgent(agent.agent_id)}
                left={
                  <span>
                    <strong>{agent.name}</strong>
                    <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>
                      {agent.model_hint ?? agent.provider}
                    </span>
                  </span>
                }
              />
            ))
          )}
        </section>
        <AgentProfileCard profile={profile} loading={loadingProfile} onQuickDm={onQuickDm} />
      </div>
    </aside>
  );
}

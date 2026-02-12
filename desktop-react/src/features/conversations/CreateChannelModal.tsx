import { useMemo, useState } from "react";
import { Button } from "@/components/primitives/Button";
import { Input } from "@/components/primitives/Input";
import { Modal } from "@/components/primitives/Modal";
import { EmptyState } from "@/components/primitives/EmptyState";
import type { AgentSummary, TeamSummary } from "@/types";

type Props = {
  open: boolean;
  pending: boolean;
  teams: TeamSummary[];
  agents: AgentSummary[];
  onClose: () => void;
  onSubmit: (args: {
    name: string;
    visibility: "private_agent" | "team" | "managers" | "org";
    teamId?: string;
    participantAgentIds: string[];
    participantTeamIds: string[];
  }) => Promise<void>;
};

export function CreateChannelModal({ open, pending, teams, agents, onClose, onSubmit }: Props) {
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"private_agent" | "team" | "managers" | "org">("team");
  const [teamId, setTeamId] = useState("");
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);

  const sortedAgents = useMemo(() => [...agents].sort((a, b) => a.name.localeCompare(b.name)), [agents]);

  return (
    <Modal
      title="Create Channel"
      open={open}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            tone="primary"
            disabled={pending || !name.trim()}
            onClick={async () => {
              await onSubmit({
                name: name.trim(),
                visibility,
                teamId: teamId || undefined,
                participantAgentIds: selectedAgentIds,
                participantTeamIds: teamId ? [teamId] : []
              });
              setName("");
              setTeamId("");
              setSelectedAgentIds([]);
            }}
          >
            {pending ? "Creating..." : "Create Channel"}
          </Button>
        </>
      }
    >
      <div className="field">
        <label>Name</label>
        <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Security" />
      </div>

      <div className="field">
        <label>Visibility</label>
        <select className="select" value={visibility} onChange={(event) => setVisibility(event.target.value as any)}>
          <option value="team">Team</option>
          <option value="managers">Managers</option>
          <option value="org">Org</option>
          <option value="private_agent">Private</option>
        </select>
      </div>

      <div className="field">
        <label>Team binding (optional)</label>
        <select className="select" value={teamId} onChange={(event) => setTeamId(event.target.value)}>
          <option value="">No team</option>
          {teams.map((team) => (
            <option key={team.team_id} value={team.team_id}>
              {team.name}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label>Participants</label>
        {sortedAgents.length === 0 ? (
          <EmptyState message="No agents available." />
        ) : (
          <div className="stack" style={{ maxHeight: 220, overflow: "auto", border: "1px solid var(--border-subtle)", borderRadius: 10, padding: 8 }}>
            {sortedAgents.map((agent) => {
              const checked = selectedAgentIds.includes(agent.agent_id);
              return (
                <label key={agent.agent_id} className="hstack" style={{ justifyContent: "space-between" }}>
                  <span>
                    {agent.name}
                    <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>
                      {agent.role}
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => {
                      setSelectedAgentIds((prev) => {
                        if (event.target.checked) return [...new Set([...prev, agent.agent_id])];
                        return prev.filter((id) => id !== agent.agent_id);
                      });
                    }}
                  />
                </label>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}


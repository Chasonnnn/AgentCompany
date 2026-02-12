import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "@/components/primitives/Button";
import { Input } from "@/components/primitives/Input";
import { Modal } from "@/components/primitives/Modal";
import { EmptyState } from "@/components/primitives/EmptyState";
import type { AgentSummary } from "@/types";

type Props = {
  open: boolean;
  pending: boolean;
  agents: AgentSummary[];
  onClose: () => void;
  onSubmit: (agentId: string) => Promise<void>;
};

export function CreateDmModal({ open, pending, agents, onClose, onSubmit }: Props) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>("");
  const parentRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter((agent) =>
      `${agent.name} ${agent.role} ${agent.model_hint ?? ""}`.toLowerCase().includes(q)
    );
  }, [agents, query]);

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 42,
    overscan: 8
  });

  return (
    <Modal
      title="New Direct Message"
      open={open}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            tone="primary"
            disabled={pending || !selectedId}
            onClick={async () => {
              await onSubmit(selectedId);
              setSelectedId("");
            }}
          >
            {pending ? "Opening..." : "Open DM"}
          </Button>
        </>
      }
    >
      <div className="field">
        <label>Search agents</label>
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, role, model" />
      </div>

      <div
        ref={parentRef}
        style={{
          minHeight: 180,
          maxHeight: 320,
          overflow: "auto",
          border: "1px solid var(--border-subtle)",
          borderRadius: 10
        }}
      >
        {filtered.length === 0 ? (
          <EmptyState message="No matching agents." />
        ) : (
          <div style={{ position: "relative", height: `${virtualizer.getTotalSize()}px` }}>
            {virtualizer.getVirtualItems().map((item) => {
              const agent = filtered[item.index];
              const selected = selectedId === agent.agent_id;
              return (
                <button
                  key={agent.agent_id}
                  type="button"
                  className={`list-row ${selected ? "active" : ""}`}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${item.start}px)`,
                    borderRadius: 0
                  }}
                  onClick={() => setSelectedId(agent.agent_id)}
                >
                  <span>
                    {agent.name}
                    <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>
                      {agent.role}
                    </span>
                  </span>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {agent.model_hint ?? agent.provider}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}


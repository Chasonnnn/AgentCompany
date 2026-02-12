import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Send } from "lucide-react";
import { Button } from "@/components/primitives/Button";
import { EmptyState } from "@/components/primitives/EmptyState";
import { TextArea } from "@/components/primitives/Input";
import type { AgentSummary, ConversationMessage } from "@/types";
import { formatDateTime } from "@/utils/format";

type Props = {
  messages: ConversationMessage[];
  agents: AgentSummary[];
  sending: boolean;
  onSendMessage: (body: string) => Promise<void>;
};

function authorName(authorId: string, agents: AgentSummary[]): string {
  if (authorId === "human_ceo") return "You";
  return agents.find((agent) => agent.agent_id === authorId)?.name ?? authorId;
}

export function ConversationView({ messages, agents, sending, onSendMessage }: Props) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState("");

  const rows = useMemo(
    () =>
      messages.map((message) => ({
        ...message,
        authorLabel: authorName(message.author_id, agents),
        createdLabel: formatDateTime(message.created_at)
      })),
    [messages, agents]
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 94,
    overscan: 8
  });

  async function submit() {
    const body = draft.trim();
    if (!body) return;
    await onSendMessage(body);
    setDraft("");
    if (parentRef.current) {
      parentRef.current.scrollTop = parentRef.current.scrollHeight;
    }
  }

  return (
    <>
      <section ref={parentRef} className="content-body timeline">
        {rows.length === 0 ? (
          <EmptyState message="No messages yet. Start the conversation." />
        ) : (
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
                  <div className="timeline-meta">
                    <strong>{row.authorLabel}</strong> · {row.createdLabel}
                  </div>
                  <div className="timeline-body">{row.body}</div>
                </article>
              );
            })}
          </div>
        )}
      </section>
      <section className="composer">
        <div className="composer-row">
          <TextArea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Message conversation..."
            onKeyDown={async (event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                await submit();
              }
            }}
          />
          <Button tone="primary" onClick={submit} disabled={sending || !draft.trim()} iconOnly title="Send">
            <Send size={16} />
          </Button>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Enter to send, Shift+Enter for newline.
        </div>
      </section>
    </>
  );
}

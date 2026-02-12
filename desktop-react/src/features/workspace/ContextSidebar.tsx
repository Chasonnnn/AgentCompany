import { Hash, Home, Inbox, MessageSquare, Plus, Wallet } from "lucide-react";
import { Button } from "@/components/primitives/Button";
import { ListRow } from "@/components/primitives/ListRow";
import { EmptyState } from "@/components/primitives/EmptyState";
import type { ConversationSummary, ProjectSummary, ScopeKind, ViewKind } from "@/types";

type Props = {
  scope: ScopeKind;
  project?: ProjectSummary;
  conversations: ConversationSummary[];
  activeView: ViewKind;
  activeConversationId?: string;
  onOpenHome: () => void;
  onOpenActivities: () => void;
  onOpenResources: () => void;
  onOpenConversation: (conversationId: string) => void;
  onCreateChannel: () => void;
  onCreateDm: () => void;
};

function conversationLabel(conversation: ConversationSummary): string {
  if (conversation.kind === "home") return "Home";
  if (conversation.kind === "channel") return `#${conversation.slug}`;
  if (conversation.kind === "dm") return conversation.name.replace(/^DM:\s*/, "");
  return conversation.name;
}

export function ContextSidebar({
  scope,
  project,
  conversations,
  activeView,
  activeConversationId,
  onOpenHome,
  onOpenActivities,
  onOpenResources,
  onOpenConversation,
  onCreateChannel,
  onCreateDm
}: Props) {
  const channels = conversations.filter((c) => c.kind === "channel");
  const dms = conversations.filter((c) => c.kind === "dm");

  return (
    <aside className="pane" style={{ display: "grid", gridTemplateRows: "auto 1fr", minHeight: 0 }}>
      <header style={{ padding: 14, borderBottom: "1px solid var(--border-subtle)" }}>
        <div style={{ fontWeight: 680 }}>{scope === "workspace" ? "Workspace" : project?.name ?? "Project"}</div>
        <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
          {scope === "workspace" ? "Portfolio and global operations" : "Project channels and PM center"}
        </div>
      </header>

      <div style={{ minHeight: 0, overflow: "auto", padding: 10 }} className="stack">
        <section className="stack">
          <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Home
          </div>
          <ListRow
            active={activeView === "home"}
            onClick={onOpenHome}
            left={
              <span className="hstack">
                <Home size={14} />
                <span>Home</span>
              </span>
            }
          />
        </section>

        {scope === "project" ? (
          <section className="stack">
            <div className="hstack" style={{ justifyContent: "space-between" }}>
              <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Channels
              </div>
              <Button iconOnly onClick={onCreateChannel} title="Create channel">
                <Plus size={14} />
              </Button>
            </div>
            {channels.length === 0 ? (
              <EmptyState message="No channels yet." />
            ) : (
              channels.map((conversation) => (
                <ListRow
                  key={conversation.id}
                  active={activeView === "conversation" && activeConversationId === conversation.id}
                  onClick={() => onOpenConversation(conversation.id)}
                  left={
                    <span className="hstack">
                      <Hash size={14} />
                      <span>{conversationLabel(conversation)}</span>
                    </span>
                  }
                />
              ))
            )}
          </section>
        ) : null}

        <section className="stack">
          <div className="hstack" style={{ justifyContent: "space-between" }}>
            <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              DMs
            </div>
            <Button iconOnly onClick={onCreateDm} title="New DM">
              <Plus size={14} />
            </Button>
          </div>
          {dms.length === 0 ? (
            <EmptyState message="No direct messages." />
          ) : (
            dms.map((conversation) => (
              <ListRow
                key={conversation.id}
                active={activeView === "conversation" && activeConversationId === conversation.id}
                onClick={() => onOpenConversation(conversation.id)}
                left={
                  <span className="hstack">
                    <MessageSquare size={14} />
                    <span>{conversationLabel(conversation)}</span>
                  </span>
                }
              />
            ))
          )}
        </section>

        <section className="stack">
          <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Views
          </div>
          <ListRow
            active={activeView === "activities"}
            onClick={onOpenActivities}
            left={
              <span className="hstack">
                <Inbox size={14} />
                <span>Activities</span>
              </span>
            }
          />
          <ListRow
            active={activeView === "resources"}
            onClick={onOpenResources}
            left={
              <span className="hstack">
                <Wallet size={14} />
                <span>Resources</span>
              </span>
            }
          />
        </section>
      </div>
    </aside>
  );
}

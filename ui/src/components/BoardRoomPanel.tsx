import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquareShare, ShieldCheck } from "lucide-react";
import type { Issue } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { agentsApi } from "@/api/agents";
import { conferenceRoomsApi } from "@/api/conferenceRooms";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { EmptyState } from "./EmptyState";
import { ConferenceRoomEditorDialog } from "./ConferenceRoomEditorDialog";

export function BoardRoomPanel({
  issue,
  composerOpen,
  onComposerOpenChange,
}: {
  issue: Issue;
  composerOpen: boolean;
  onComposerOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const { data: rooms, isLoading } = useQuery({
    queryKey: queryKeys.conferenceRooms.issueList(issue.id),
    queryFn: () => conferenceRoomsApi.listForIssue(issue.id),
  });

  const { data: hierarchy } = useQuery({
    queryKey: queryKeys.agents.operatingHierarchy(issue.companyId),
    queryFn: () => agentsApi.operatingHierarchy(issue.companyId),
    enabled: composerOpen,
  });

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(issue.companyId),
    queryFn: () => issuesApi.list(issue.companyId, { limit: 200 }),
    enabled: composerOpen,
  });

  const createRoom = useMutation({
    mutationFn: (data: Parameters<typeof conferenceRoomsApi.createForIssue>[1]) =>
      conferenceRoomsApi.createForIssue(issue.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.conferenceRooms.issueList(issue.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.conferenceRooms.list(issue.companyId) });
      onComposerOpenChange(false);
    },
  });

  const sortedRooms = useMemo(
    () => (rooms ?? []).slice().sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()),
    [rooms],
  );

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card/80 p-4 shadow-sm sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="inline-flex items-center gap-2 text-sm font-semibold text-foreground">
            <ShieldCheck className="h-4 w-4 text-amber-600 dark:text-amber-300" />
            Conference Room
          </div>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            Open a room linked to this issue when work needs coordinated leadership discussion. Formal board approvals happen later from inside the room.
          </p>
        </div>
        <Button className="sm:self-start" onClick={() => onComposerOpenChange(true)} disabled={createRoom.isPending}>
          <MessageSquareShare className="mr-1.5 h-4 w-4" />
          {createRoom.isPending ? "Creating..." : "Open conference room"}
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading linked conference rooms…</p>
      ) : sortedRooms.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          message="No conference rooms linked to this issue yet."
          action="Open conference room"
          onAction={() => onComposerOpenChange(true)}
        />
      ) : (
        <div className="grid gap-3">
          {sortedRooms.map((room) => (
            <Link
              key={room.id}
              to={`/conference-room/rooms/${room.id}`}
              className="rounded-xl border border-border/70 bg-card/70 p-4 transition-colors hover:bg-accent/20"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-base font-semibold">{room.title}</span>
                    <span className="rounded-full border border-border px-2 py-0.5 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                      {room.status}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground">{room.summary}</p>
                </div>
                <div className="grid grid-cols-3 gap-2 text-right text-xs text-muted-foreground">
                  <div>
                    <div className="font-medium text-foreground">{room.participants.length}</div>
                    <div>leaders</div>
                  </div>
                  <div>
                    <div className="font-medium text-foreground">{room.decisions.length}</div>
                    <div>decisions</div>
                  </div>
                  <div>
                    <div className="font-medium text-foreground">{room.linkedIssues.length}</div>
                    <div>issues</div>
                  </div>
                </div>
              </div>
              {room.decisions.length > 0 ? (
                <div className="mt-3 rounded-lg border border-border/60 bg-background/70 px-3 py-2 text-sm text-muted-foreground">
                  Latest decision: {room.decisions[0]?.title}
                </div>
              ) : null}
            </Link>
          ))}
        </div>
      )}

      {hierarchy && issues ? (
        <ConferenceRoomEditorDialog
          open={composerOpen}
          onOpenChange={onComposerOpenChange}
          hierarchy={hierarchy}
          issues={issues}
          requiredIssueIds={[issue.id]}
          isPending={createRoom.isPending}
          onSubmit={async (draft) => {
            await createRoom.mutateAsync(draft);
          }}
        />
      ) : null}
    </section>
  );
}

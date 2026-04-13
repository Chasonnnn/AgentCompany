import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquareShare, PencilLine, ShieldCheck } from "lucide-react";
import { getConferenceRoomKindDescriptor, type Agent } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { conferenceRoomsApi } from "../api/conferenceRooms";
import { issuesApi } from "../api/issues";
import { PageSkeleton } from "../components/PageSkeleton";
import { ConferenceRoomEditorDialog } from "../components/ConferenceRoomEditorDialog";
import { PacketMarkdownBody } from "../components/PacketMarkdownBody";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { issueUrl } from "../lib/utils";

export function ConferenceRoomDetail() {
  const { roomId } = useParams<{ roomId: string }>();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const [editOpen, setEditOpen] = useState(false);
  const [decisionOpen, setDecisionOpen] = useState(false);
  const [commentBody, setCommentBody] = useState("");
  const [decisionDraft, setDecisionDraft] = useState({
    title: "",
    summary: "",
    recommendedAction: "",
    nextActionOnApproval: "",
    risks: "",
    proposedComment: "",
  });

  const roomQuery = useQuery({
    queryKey: roomId ? queryKeys.conferenceRooms.detail(roomId) : ["conference-rooms", "detail", "missing"],
    queryFn: () => conferenceRoomsApi.get(roomId!),
    enabled: !!roomId,
  });

  const room = roomQuery.data ?? null;

  useEffect(() => {
    setBreadcrumbs([
      { label: "Conference Room", href: "/conference-room" },
      ...(room ? [{ label: room.title }] : [{ label: "Room" }]),
    ]);
  }, [room, setBreadcrumbs]);

  const { data: comments } = useQuery({
    queryKey: roomId ? queryKeys.conferenceRooms.comments(roomId) : ["conference-rooms", "comments", "missing"],
    queryFn: () => conferenceRoomsApi.listComments(roomId!),
    enabled: !!roomId,
  });

  const { data: agents } = useQuery({
    queryKey: room ? queryKeys.agents.list(room.companyId) : ["agents", "room", "missing"],
    queryFn: () => agentsApi.list(room!.companyId),
    enabled: !!room,
  });

  const { data: hierarchy } = useQuery({
    queryKey: room ? queryKeys.agents.operatingHierarchy(room.companyId) : ["agents", "operating-hierarchy", "missing"],
    queryFn: () => agentsApi.operatingHierarchy(room!.companyId),
    enabled: !!room,
  });

  const { data: issues } = useQuery({
    queryKey: room ? queryKeys.issues.list(room.companyId) : ["issues", "room", "missing"],
    queryFn: () => issuesApi.list(room!.companyId, { limit: 200 }),
    enabled: !!room,
  });

  const agentMap = useMemo(() => new Map((agents ?? []).map((agent) => [agent.id, agent])), [agents]);

  const updateRoom = useMutation({
    mutationFn: (data: Parameters<typeof conferenceRoomsApi.update>[1]) =>
      conferenceRoomsApi.update(roomId!, data),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.conferenceRooms.detail(updated.id), updated);
      queryClient.invalidateQueries({ queryKey: queryKeys.conferenceRooms.list(updated.companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.conferenceRooms.issueList(updated.linkedIssues[0]?.issueId ?? "") });
      setEditOpen(false);
      pushToast({ title: "Conference room updated", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Update failed",
        body: error instanceof Error ? error.message : "Unable to update conference room",
        tone: "error",
      });
    },
  });

  const addComment = useMutation({
    mutationFn: () => conferenceRoomsApi.addComment(roomId!, commentBody.trim()),
    onSuccess: () => {
      setCommentBody("");
      queryClient.invalidateQueries({ queryKey: queryKeys.conferenceRooms.comments(roomId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.conferenceRooms.detail(roomId!) });
    },
  });

  const requestDecision = useMutation({
    mutationFn: () =>
      conferenceRoomsApi.requestBoardDecision(roomId!, {
        title: decisionDraft.title.trim(),
        summary: decisionDraft.summary.trim(),
        recommendedAction: decisionDraft.recommendedAction,
        nextActionOnApproval: decisionDraft.nextActionOnApproval,
        risks: decisionDraft.risks
          .split("\n")
          .map((entry) => entry.trim())
          .filter(Boolean),
        proposedComment: decisionDraft.proposedComment,
      }),
    onSuccess: (approval) => {
      setDecisionOpen(false);
      queryClient.invalidateQueries({ queryKey: queryKeys.conferenceRooms.detail(roomId!) });
      if (room) {
        queryClient.invalidateQueries({ queryKey: queryKeys.conferenceRooms.list(room.companyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(room.companyId) });
      }
      navigate(`/approvals/${approval.id}`);
    },
    onError: (error) => {
      pushToast({
        title: "Decision request failed",
        body: error instanceof Error ? error.message : "Unable to request board decision",
        tone: "error",
      });
    },
  });

  if (roomQuery.isLoading) {
    return <PageSkeleton variant="approvals" />;
  }

  if (!room) {
    return <p className="text-sm text-muted-foreground">Conference room not found.</p>;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 text-sm font-semibold text-foreground">
            <MessageSquareShare className="h-4 w-4 text-muted-foreground" />
            Conference Room
          </div>
          <div>
            <h1 className="text-xl font-semibold">{room.title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{room.summary}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="rounded-full border border-border/60 bg-background/70 px-2.5 py-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
              {getConferenceRoomKindDescriptor(room.kind)?.label ?? "Legacy room"}
            </span>
            <span className="rounded-full border border-border/60 bg-background/70 px-2.5 py-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
              {room.status}
            </span>
          </div>
          {room.agenda ? (
            <div className="rounded-lg border border-border/60 bg-background/70 px-3.5 py-3 text-sm text-foreground/90">
              {room.agenda}
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setEditOpen(true)}>
            <PencilLine className="mr-1.5 h-4 w-4" />
            Edit room
          </Button>
          <Button onClick={() => setDecisionOpen(true)}>
            <ShieldCheck className="mr-1.5 h-4 w-4" />
            Request board decision
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <section className="space-y-4">
          <div className="rounded-xl border border-border/70 bg-card/60 p-4">
            <h2 className="text-sm font-semibold">Linked issues</h2>
            <div className="mt-3 space-y-2">
              {room.linkedIssues.length === 0 ? (
                <p className="text-sm text-muted-foreground">No linked issues.</p>
              ) : (
                room.linkedIssues.map((issue) => (
                  <Link
                    key={issue.issueId}
                    to={issueUrl({
                      id: issue.issueId,
                      identifier: issue.identifier,
                      title: issue.title,
                    } as never)}
                    className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/70 px-3 py-2 text-sm hover:bg-accent/30"
                  >
                    <span className="font-mono text-xs text-muted-foreground">
                      {issue.identifier ?? issue.issueId.slice(0, 8)}
                    </span>
                    <span className="truncate">{issue.title}</span>
                  </Link>
                ))
              )}
            </div>
          </div>

          <div className="rounded-xl border border-border/70 bg-card/60 p-4">
            <h2 className="text-sm font-semibold">Participants</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {room.participants.length === 0 ? (
                <p className="text-sm text-muted-foreground">No invited leaders.</p>
              ) : (
                room.participants.map((participant) => (
                  <span key={participant.id} className="rounded-full border border-border/60 bg-background/80 px-3 py-1.5 text-sm">
                    {agentMap.get(participant.agentId)?.name ?? participant.agentId}
                  </span>
                ))
              )}
            </div>
          </div>

          <div className="rounded-xl border border-border/70 bg-card/60 p-4">
            <h2 className="text-sm font-semibold">Decision history</h2>
            <div className="mt-3 space-y-3">
              {room.decisions.length === 0 ? (
                <p className="text-sm text-muted-foreground">No board decisions requested yet.</p>
              ) : (
                room.decisions.map((decision) => (
                  <Link
                    key={decision.approvalId}
                    to={`/approvals/${decision.approvalId}`}
                    className="block rounded-lg border border-border/60 bg-background/70 px-3 py-3 hover:bg-accent/30"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium">{decision.title}</span>
                      <span className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
                        {decision.status.replaceAll("_", " ")}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{decision.summary}</p>
                  </Link>
                ))
              )}
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-border/70 bg-card/60 p-4">
          <h2 className="text-sm font-semibold">Discussion</h2>
          <div className="mt-3 space-y-3">
            {(comments ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No conference-room comments yet.</p>
            ) : (
              comments?.map((comment) => (
                <div key={comment.id} className="rounded-lg border border-border/60 bg-background/80 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium">
                      {comment.authorAgentId
                        ? agentMap.get(comment.authorAgentId)?.name ?? comment.authorAgentId
                        : "Board"}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(comment.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="mt-2">
                    <PacketMarkdownBody markdown={comment.body} className="text-sm leading-6" />
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="mt-4 space-y-2">
            <Label htmlFor="conference-room-comment">Add comment</Label>
            <Textarea
              id="conference-room-comment"
              value={commentBody}
              onChange={(event) => setCommentBody(event.target.value)}
              placeholder="Add context, questions, or guidance."
            />
            <div className="flex justify-end">
              <Button
                onClick={() => void addComment.mutateAsync()}
                disabled={!commentBody.trim() || addComment.isPending}
              >
                {addComment.isPending ? "Posting..." : "Post comment"}
              </Button>
            </div>
          </div>
        </section>
      </div>

      {hierarchy && issues ? (
        <ConferenceRoomEditorDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          room={room}
          hierarchy={hierarchy}
          issues={issues}
          isPending={updateRoom.isPending}
          onSubmit={async (draft) => {
            await updateRoom.mutateAsync(draft);
          }}
        />
      ) : null}

      <Dialog open={decisionOpen} onOpenChange={(next) => !requestDecision.isPending && setDecisionOpen(next)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Request board decision</DialogTitle>
            <DialogDescription>
              Formalize the decision request without collapsing the room into the approval itself.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="decision-title">Title</Label>
                <Input
                  id="decision-title"
                  value={decisionDraft.title}
                  onChange={(event) => setDecisionDraft((current) => ({ ...current, title: event.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="decision-summary">Summary</Label>
                <Input
                  id="decision-summary"
                  value={decisionDraft.summary}
                  onChange={(event) => setDecisionDraft((current) => ({ ...current, summary: event.target.value }))}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="decision-recommended-action">Recommended action</Label>
              <Textarea
                id="decision-recommended-action"
                value={decisionDraft.recommendedAction}
                onChange={(event) => setDecisionDraft((current) => ({ ...current, recommendedAction: event.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="decision-next-action">Next action on approval</Label>
              <Textarea
                id="decision-next-action"
                value={decisionDraft.nextActionOnApproval}
                onChange={(event) => setDecisionDraft((current) => ({ ...current, nextActionOnApproval: event.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="decision-risks">Risks</Label>
              <Textarea
                id="decision-risks"
                value={decisionDraft.risks}
                onChange={(event) => setDecisionDraft((current) => ({ ...current, risks: event.target.value }))}
                placeholder="One risk per line"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="decision-comment">Proposed comment</Label>
              <Textarea
                id="decision-comment"
                value={decisionDraft.proposedComment}
                onChange={(event) => setDecisionDraft((current) => ({ ...current, proposedComment: event.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDecisionOpen(false)} disabled={requestDecision.isPending}>
              Cancel
            </Button>
            <Button
              onClick={() => void requestDecision.mutateAsync()}
              disabled={!decisionDraft.title.trim() || !decisionDraft.summary.trim() || requestDecision.isPending}
            >
              {requestDecision.isPending ? "Creating..." : "Create approval"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquareReply, MessageSquareShare, PencilLine, ShieldCheck } from "lucide-react";
import {
  getConferenceRoomKindDescriptor,
  type ConferenceRoomComment,
  type ConferenceRoomMessageType,
  type Agent,
} from "@paperclipai/shared";
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

function authorLabel(comment: ConferenceRoomComment, agentMap: Map<string, Agent>) {
  if (!comment.authorAgentId) return "Board";
  return agentMap.get(comment.authorAgentId)?.name ?? comment.authorAgentId;
}

function responseTone(status: string) {
  if (status === "replied") return "text-emerald-300 border-emerald-500/30 bg-emerald-500/10";
  if (status === "dismissed") return "text-muted-foreground border-border/60 bg-background/60";
  return "text-amber-200 border-amber-500/30 bg-amber-500/10";
}

function questionSummary(comment: ConferenceRoomComment) {
  const pending = comment.responses.filter((response) => response.status === "pending").length;
  const replied = comment.responses.filter((response) => response.status === "replied").length;
  const dismissed = comment.responses.filter((response) => response.status === "dismissed").length;
  return { pending, replied, dismissed };
}

function replyPlaceholder(type: ConferenceRoomMessageType, replying: boolean) {
  if (replying) return "Reply in thread.";
  if (type === "question") return "Ask a question that each invited agent should answer in thread.";
  return "Add context, direction, or a new room message.";
}

export function ConferenceRoomDetail() {
  const { roomId } = useParams<{ roomId: string }>();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const [editOpen, setEditOpen] = useState(false);
  const [decisionOpen, setDecisionOpen] = useState(false);
  const [commentBody, setCommentBody] = useState("");
  const [commentType, setCommentType] = useState<ConferenceRoomMessageType>("note");
  const [replyToCommentId, setReplyToCommentId] = useState<string | null>(null);
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
    refetchInterval: (query) => (query.state.data?.status === "open" ? 3_000 : false),
  });

  const room = roomQuery.data ?? null;

  useEffect(() => {
    setBreadcrumbs([
      { label: "Conference Room", href: "/conference-room" },
      ...(room ? [{ label: room.title }] : [{ label: "Room" }]),
    ]);
  }, [room, setBreadcrumbs]);

  const commentsQuery = useQuery({
    queryKey: roomId ? queryKeys.conferenceRooms.comments(roomId) : ["conference-rooms", "comments", "missing"],
    queryFn: () => conferenceRoomsApi.listComments(roomId!),
    enabled: !!roomId,
    refetchInterval: room?.status === "open" ? 3_000 : false,
  });

  const comments = commentsQuery.data ?? [];

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

  const commentsById = useMemo(
    () => new Map(comments.map((comment) => [comment.id, comment])),
    [comments],
  );

  const childCommentsByParentId = useMemo(() => {
    const children = new Map<string, ConferenceRoomComment[]>();
    for (const comment of comments) {
      if (!comment.parentCommentId) continue;
      const group = children.get(comment.parentCommentId) ?? [];
      group.push(comment);
      children.set(comment.parentCommentId, group);
    }
    return children;
  }, [comments]);

  const topLevelComments = useMemo(
    () => comments.filter((comment) => !comment.parentCommentId),
    [comments],
  );

  const replyTarget = replyToCommentId ? commentsById.get(replyToCommentId) ?? null : null;
  const roomOpen = room?.status === "open";

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
    mutationFn: () =>
      conferenceRoomsApi.addComment(roomId!, {
        body: commentBody.trim(),
        messageType: replyToCommentId ? "note" : commentType,
        ...(replyToCommentId ? { parentCommentId: replyToCommentId } : {}),
      }),
    onSuccess: () => {
      setCommentBody("");
      setCommentType("note");
      setReplyToCommentId(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.conferenceRooms.comments(roomId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.conferenceRooms.detail(roomId!) });
    },
    onError: (error) => {
      pushToast({
        title: "Post failed",
        body: error instanceof Error ? error.message : "Unable to post conference-room message",
        tone: "error",
      });
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

  function renderCommentThread(comment: ConferenceRoomComment, depth = 0) {
    const childComments = childCommentsByParentId.get(comment.id) ?? [];
    const summary = questionSummary(comment);
    const isQuestion = comment.messageType === "question";
    const canReply = roomOpen;

    return (
      <div key={comment.id} className={depth > 0 ? "ml-4 border-l border-border/60 pl-4" : ""}>
        <div className="rounded-lg border border-border/60 bg-background/80 p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{authorLabel(comment, agentMap)}</span>
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] ${
                  isQuestion
                    ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
                    : "border-border/60 bg-background/70 text-muted-foreground"
                }`}
              >
                {comment.messageType}
              </span>
            </div>
            <span className="text-xs text-muted-foreground">
              {new Date(comment.createdAt).toLocaleString()}
            </span>
          </div>

          <div className="mt-2">
            <PacketMarkdownBody markdown={comment.body} className="text-sm leading-6" />
          </div>

          {comment.responses.length > 0 ? (
            <div className="mt-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{summary.pending} pending</span>
                <span>{summary.replied} replied</span>
                {summary.dismissed > 0 ? <span>{summary.dismissed} dismissed</span> : null}
              </div>
              <div className="flex flex-wrap gap-2">
                {comment.responses.map((response) => (
                  <span
                    key={`${comment.id}:${response.agentId}`}
                    className={`rounded-full border px-2 py-1 text-[11px] ${responseTone(response.status)}`}
                  >
                    {(agentMap.get(response.agentId)?.name ?? response.agentId)} - {response.status}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {canReply ? (
            <div className="mt-3 flex justify-end">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setReplyToCommentId(comment.id)}
              >
                <MessageSquareReply className="mr-1.5 h-3.5 w-3.5" />
                Reply
              </Button>
            </div>
          ) : null}
        </div>

        {childComments.length > 0 ? (
          <div className="mt-3 space-y-3">
            {childComments.map((child) => renderCommentThread(child, depth + 1))}
          </div>
        ) : null}
      </div>
    );
  }

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
                <p className="text-sm text-muted-foreground">No invited participants.</p>
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

        <section
          data-testid="conference-room-discussion"
          className="rounded-xl border border-border/70 bg-card/60 p-4 lg:sticky lg:top-4 lg:flex lg:max-h-[calc(100vh-2rem)] lg:min-h-0 lg:flex-col lg:overflow-hidden"
        >
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">Discussion</h2>
            {room.status === "open" ? (
              <span className="text-xs text-muted-foreground">Auto-refreshing</span>
            ) : null}
          </div>

          <div
            data-testid="conference-room-discussion-scroll"
            className="mt-3 space-y-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-1"
          >
            {comments.length === 0 ? (
              <p className="text-sm text-muted-foreground">No conference-room messages yet.</p>
            ) : (
              topLevelComments.map((comment) => renderCommentThread(comment))
            )}
          </div>

          <div className="mt-4 space-y-3 border-t border-border/60 pt-4">
            <div className="space-y-2">
              <Label htmlFor="conference-room-comment">
                {replyTarget ? "Reply in thread" : "New room message"}
              </Label>

              {replyTarget ? (
                <div className="rounded-lg border border-border/60 bg-background/70 px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium">
                      Replying to {authorLabel(replyTarget, agentMap)} ({replyTarget.messageType})
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setReplyToCommentId(null);
                        setCommentType("note");
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {replyTarget.body.replace(/\s+/g, " ").slice(0, 180)}
                    {replyTarget.body.length > 180 ? "..." : ""}
                  </p>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={commentType === "note" ? "default" : "outline"}
                    onClick={() => setCommentType("note")}
                    disabled={!roomOpen}
                  >
                    Note
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={commentType === "question" ? "default" : "outline"}
                    onClick={() => setCommentType("question")}
                    disabled={!roomOpen}
                  >
                    Question
                  </Button>
                </div>
              )}
            </div>

            <Textarea
              id="conference-room-comment"
              value={commentBody}
              onChange={(event) => setCommentBody(event.target.value)}
              placeholder={replyPlaceholder(commentType, Boolean(replyTarget))}
              disabled={!roomOpen}
            />

            <div className="flex justify-end">
              <Button
                onClick={() => void addComment.mutateAsync()}
                disabled={!roomOpen || !commentBody.trim() || addComment.isPending}
              >
                {addComment.isPending
                  ? "Posting..."
                  : replyTarget
                    ? "Post reply"
                    : commentType === "question"
                      ? "Post question"
                      : "Post message"}
              </Button>
            </div>

            {!roomOpen ? (
              <p className="text-xs text-muted-foreground">
                Closed or archived rooms keep the thread visible but do not accept new messages.
              </p>
            ) : null}
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

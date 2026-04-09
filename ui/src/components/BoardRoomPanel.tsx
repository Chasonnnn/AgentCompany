import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent, Approval, ApprovalComment } from "@paperclipai/shared";
import { MessageSquareShare, ShieldCheck } from "lucide-react";
import { ApprovalCard } from "./ApprovalCard";
import { ConferenceContextSummary } from "./ConferenceContextSummary";
import { EmptyState } from "./EmptyState";
import { Identity } from "./Identity";
import { MarkdownBody } from "./MarkdownBody";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { approvalsApi } from "@/api/approvals";
import { issuesApi } from "@/api/issues";
import {
  boardRoomAgenda,
  boardRoomParticipantAgentIds,
  boardRoomRoomTitle,
  isBoardRoomApproval,
  normalizeBoardRoomRequestPayload,
} from "@/lib/board-room";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

type PendingApprovalAction = {
  approvalId: string;
  action: "approve" | "reject";
} | null;

function ConferenceRoomMetadata({
  approval,
  agentMap,
}: {
  approval: Approval;
  agentMap: Map<string, Agent>;
}) {
  const payload = approval.payload as Record<string, unknown> | null;
  const roomTitle = boardRoomRoomTitle(payload);
  const agenda = boardRoomAgenda(payload);
  const participantIds = boardRoomParticipantAgentIds(payload);

  if (!roomTitle && !agenda && participantIds.length === 0) {
    return null;
  }

  return (
    <div className="rounded-xl border border-border/60 bg-background/70 p-4">
      <div className="grid gap-4 md:grid-cols-2">
        {roomTitle ? (
          <div className="space-y-1">
            <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Conference
            </p>
            <p className="text-sm font-medium text-foreground">{roomTitle}</p>
          </div>
        ) : null}
        {agenda ? (
          <div className="space-y-1">
            <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Agenda
            </p>
            <p className="text-sm leading-6 text-foreground/90">{agenda}</p>
          </div>
        ) : null}
      </div>
      {participantIds.length > 0 ? (
        <div className="mt-4 space-y-2">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Participants
          </p>
          <div className="flex flex-wrap gap-2">
            {participantIds.map((participantId) => {
              const agent = agentMap.get(participantId);
              return (
                <div
                  key={participantId}
                  className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-card px-2.5 py-1.5 text-xs"
                >
                  {agent ? (
                    <Identity name={agent.name} size="sm" className="inline-flex" />
                  ) : (
                    <span className="font-mono text-muted-foreground">{participantId}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function BoardRoomDiscussion({
  approval,
  agentMap,
}: {
  approval: Approval;
  agentMap: Map<string, Agent>;
}) {
  const queryClient = useQueryClient();
  const [commentBody, setCommentBody] = useState("");
  const {
    data: comments,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: queryKeys.approvals.comments(approval.id),
    queryFn: () => approvalsApi.listComments(approval.id),
  });

  const addComment = useMutation({
    mutationFn: async () => approvalsApi.addComment(approval.id, commentBody.trim()),
    onSuccess: (comment) => {
      setCommentBody("");
      queryClient.setQueryData<ApprovalComment[]>(
        queryKeys.approvals.comments(approval.id),
        (current) => [...(current ?? []), comment],
      );
    },
  });

  return (
    <div className="rounded-xl border border-border/60 bg-background/70 p-4">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium text-foreground">Conference Discussion</h4>
        <span className="text-xs text-muted-foreground">
          {comments?.length ?? 0} comments
        </span>
      </div>

      <div className="mt-3 space-y-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading conference discussion...</p>
        ) : isError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <p>{error instanceof Error ? error.message : "Unable to load conference discussion."}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => {
                void refetch();
              }}
            >
              Retry
            </Button>
          </div>
        ) : (comments ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No conference-room comments yet.</p>
        ) : (
          <div className="space-y-2">
            {(comments ?? []).map((comment) => {
              const authorName = comment.authorAgentId
                ? agentMap.get(comment.authorAgentId)?.name ?? comment.authorAgentId.slice(0, 8)
                : "Board";
              return (
                <div key={comment.id} className="rounded-lg border border-border/60 bg-card/80 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <Identity name={authorName} size="sm" />
                    <span className="text-xs text-muted-foreground">
                      {new Date(comment.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <MarkdownBody className="mt-2 text-sm">{comment.body}</MarkdownBody>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="mt-4 space-y-2">
        <Label htmlFor={`board-comment-${approval.id}`}>Add board comment</Label>
        <Textarea
          id={`board-comment-${approval.id}`}
          name={`boardComment-${approval.id}`}
          value={commentBody}
          onChange={(event) => setCommentBody(event.target.value)}
          placeholder="Add decision context, objections, or follow-up guidance."
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={() => {
              void addComment.mutateAsync();
            }}
            disabled={!commentBody.trim() || addComment.isPending}
          >
            {addComment.isPending ? "Posting..." : "Post comment"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function BoardRoomPanel({
  issueId,
  approvals,
  agentMap,
  onRequestBoardDecision,
  onApproveApproval,
  onRejectApproval,
  pendingApprovalAction,
  requestPending = false,
  composerOpen: composerOpenProp,
  onComposerOpenChange,
}: {
  issueId?: string;
  approvals: Approval[] | undefined;
  agentMap: Map<string, Agent>;
  onRequestBoardDecision: (payload: Record<string, unknown>) => Promise<void>;
  onApproveApproval: (approvalId: string) => Promise<void>;
  onRejectApproval: (approvalId: string) => Promise<void>;
  pendingApprovalAction: PendingApprovalAction;
  requestPending?: boolean;
  composerOpen?: boolean;
  onComposerOpenChange?: (open: boolean) => void;
}) {
  const [composerOpenInternal, setComposerOpenInternal] = useState(false);
  const [expandedApprovalId, setExpandedApprovalId] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const composerOpen = composerOpenProp ?? composerOpenInternal;
  const conferenceContextQuery = useQuery({
    queryKey: issueId
      ? queryKeys.issues.conferenceContext(issueId)
      : ["issues", "conference-context", "missing"],
    queryFn: async () => {
      if (!issueId) {
        throw new Error("Issue context unavailable");
      }
      return issuesApi.getConferenceContext(issueId);
    },
    enabled: composerOpen && Boolean(issueId),
    retry: false,
  });

  const boardApprovals = useMemo(
    () => (approvals ?? []).filter(isBoardRoomApproval),
    [approvals],
  );

  function setComposerOpen(open: boolean) {
    if (composerOpenProp === undefined) {
      setComposerOpenInternal(open);
    }
    onComposerOpenChange?.(open);
  }

  function openComposer() {
    setComposerOpen(true);
  }

  function closeComposer() {
    if (requestPending) return;
    setComposerOpen(false);
    formRef.current?.reset();
  }

  async function submit() {
    if (requestPending) return;
    const form = formRef.current;
    if (!form) return;

    const formData = new FormData(form);
    const title = String(formData.get("title") ?? "");
    const summary = String(formData.get("summary") ?? "");
    if (!title.trim() || !summary.trim()) return;

    try {
      await onRequestBoardDecision(
        normalizeBoardRoomRequestPayload({
          title,
          summary,
          roomTitle: String(formData.get("roomTitle") ?? ""),
          agenda: String(formData.get("agenda") ?? ""),
          recommendedAction: String(formData.get("recommendedAction") ?? ""),
          nextActionOnApproval: String(formData.get("nextActionOnApproval") ?? ""),
          risks: String(formData.get("risks") ?? ""),
          proposedComment: String(formData.get("proposedComment") ?? ""),
          participantAgentIds: formData
            .getAll("participantAgentIds")
            .filter((value): value is string => typeof value === "string"),
        }),
      );
      setComposerOpen(false);
      form.reset();
    } catch {
      // The page-level mutation surfaces the error toast and keeps the draft open for retry.
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card/80 p-4 shadow-sm sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="inline-flex items-center gap-2 text-sm font-semibold text-foreground">
            <ShieldCheck className="h-4 w-4 text-amber-600 dark:text-amber-300" />
            Conference Room
          </div>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            Use an issue-scoped conference room when execution needs coordinated discussion, invited agent participants, and explicit human signoff before work continues.
          </p>
        </div>
        <Button className="sm:self-start" onClick={openComposer} disabled={requestPending}>
          <MessageSquareShare className="mr-1.5 h-4 w-4" />
          {requestPending ? "Creating..." : "Request board decision"}
        </Button>
      </div>

      {boardApprovals.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          message="No conference-room decisions yet for this issue."
          action="Request board decision"
          onAction={openComposer}
        />
      ) : (
        <div className="space-y-3">
          {boardApprovals.map((approval) => (
            <div key={approval.id} className="space-y-3">
              <ApprovalCard
                approval={approval}
                requesterAgent={approval.requestedByAgentId ? agentMap.get(approval.requestedByAgentId) ?? null : null}
                onApprove={() => onApproveApproval(approval.id)}
                onReject={() => onRejectApproval(approval.id)}
                detailLink={`/approvals/${approval.id}`}
                isPending={pendingApprovalAction?.approvalId === approval.id}
                pendingAction={
                  pendingApprovalAction?.approvalId === approval.id
                    ? pendingApprovalAction.action
                    : null
                }
              />
              <ConferenceRoomMetadata approval={approval} agentMap={agentMap} />
              <div className="flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn("text-xs text-muted-foreground")}
                  onClick={() => {
                    setExpandedApprovalId((current) =>
                      current === approval.id ? null : approval.id,
                    );
                  }}
                >
                  {expandedApprovalId === approval.id ? "Hide discussion" : "Open discussion"}
                </Button>
              </div>
              {expandedApprovalId === approval.id ? (
                <BoardRoomDiscussion
                  approval={approval}
                  agentMap={agentMap}
                />
              ) : null}
            </div>
          ))}
        </div>
      )}

      <Dialog open={composerOpen} onOpenChange={(open) => {
        if (!open) {
          closeComposer();
          return;
        }
        setComposerOpen(true);
      }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Open conference room</DialogTitle>
            <DialogDescription>
              Capture the decision, agenda, invited participants, and approval follow-up in a structured conference-room request linked to this issue.
            </DialogDescription>
          </DialogHeader>

          <form ref={formRef} className="space-y-4" onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}>
            <div className="space-y-2">
              <Label htmlFor="board-room-title">Title</Label>
              <Input
                id="board-room-title"
                name="title"
                placeholder="Approve the launch sequence for the customer migration"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="board-room-summary">Summary</Label>
              <Textarea
                id="board-room-summary"
                name="summary"
                placeholder="Explain what changed, why a board decision is required, and what is blocked."
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="board-room-room-title">Conference Title</Label>
                <Input
                  id="board-room-room-title"
                  name="roomTitle"
                  placeholder="Migration Readiness Council"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="board-room-agenda">Agenda</Label>
                <Textarea
                  id="board-room-agenda"
                  name="agenda"
                  placeholder="Review blockers, risks, and the staged rollout plan."
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="board-room-recommended-action">Recommended Action</Label>
              <Textarea
                id="board-room-recommended-action"
                name="recommendedAction"
                placeholder="Proceed with the issue-level board room pilot in the current company only."
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="board-room-next-action">Next Action On Approval</Label>
              <Textarea
                id="board-room-next-action"
                name="nextActionOnApproval"
                placeholder="Implement the approved change and post the evidence link back to this issue."
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="board-room-risks">Risks</Label>
              <Textarea
                id="board-room-risks"
                name="risks"
                placeholder={"One risk per line\nThis adds another review surface for operators"}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="board-room-proposed-comment">Proposed Comment</Label>
              <Textarea
                id="board-room-proposed-comment"
                name="proposedComment"
                placeholder="Optional response the board can post when the request is approved."
              />
            </div>

            <div className="space-y-2">
              <Label>Invite Participants</Label>
              {Array.from(agentMap.values()).length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No agents are available yet for this conference room.
                </p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {Array.from(agentMap.values())
                    .sort((left, right) => left.name.localeCompare(right.name))
                    .map((agent) => (
                      <label
                        key={agent.id}
                        className="flex cursor-pointer items-center gap-3 rounded-lg border border-border/60 bg-background/60 px-3 py-2.5 text-sm"
                      >
                        <input
                          type="checkbox"
                          name="participantAgentIds"
                          value={agent.id}
                          className="h-4 w-4"
                        />
                        <div className="min-w-0">
                          <div className="font-medium text-foreground">{agent.name}</div>
                          <div className="text-xs text-muted-foreground">{agent.role.replace(/_/g, " ")}</div>
                        </div>
                      </label>
                  ))}
                </div>
              )}
            </div>

            {composerOpen ? (
              conferenceContextQuery.isLoading ? (
                <div className="rounded-xl border border-border/60 bg-background/70 p-4 text-sm text-muted-foreground">
                  Loading repo context...
                </div>
              ) : conferenceContextQuery.isError ? (
                <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
                  {conferenceContextQuery.error instanceof Error
                    ? conferenceContextQuery.error.message
                    : "Unable to load repo context preview."}
                </div>
              ) : (
                <ConferenceContextSummary
                  context={conferenceContextQuery.data}
                  title="Live Repo Context Preview"
                  emptyMessage="No inspectable repo context is available for this issue."
                />
              )
            ) : null}
          </form>

          <DialogFooter>
            <Button variant="outline" onClick={closeComposer} disabled={requestPending}>
              Cancel
            </Button>
            <Button onClick={() => void submit()} disabled={requestPending}>
              {requestPending ? "Creating..." : "Create board request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

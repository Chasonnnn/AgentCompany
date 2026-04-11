import { useEffect, useMemo, useState } from "react";
import type { CompanyOperatingHierarchy, ConferenceRoom, Issue } from "@paperclipai/shared";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { collectExecutiveIds, collectLeaderIds, conferenceRoomLeadershipBulkGroups } from "../lib/conference-rooms";

type ConferenceRoomDraft = {
  title: string;
  summary: string;
  agenda: string;
  issueIds: string[];
  participantAgentIds: string[];
};

function createDraft(room?: ConferenceRoom | null): ConferenceRoomDraft {
  return {
    title: room?.title ?? "",
    summary: room?.summary ?? "",
    agenda: room?.agenda ?? "",
    issueIds: room?.linkedIssues.map((issue) => issue.issueId) ?? [],
    participantAgentIds: room?.participants.map((participant) => participant.agentId) ?? [],
  };
}

export function ConferenceRoomEditorDialog({
  open,
  onOpenChange,
  room,
  hierarchy,
  issues,
  requiredIssueIds = [],
  isPending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  room?: ConferenceRoom | null;
  hierarchy: CompanyOperatingHierarchy;
  issues: Issue[];
  requiredIssueIds?: string[];
  isPending: boolean;
  onSubmit: (draft: {
    title: string;
    summary: string;
    agenda: string | null;
    issueIds: string[];
    participantAgentIds: string[];
  }) => Promise<void>;
}) {
  const [draft, setDraft] = useState<ConferenceRoomDraft>(() => createDraft(room));

  useEffect(() => {
    if (open) {
      const next = createDraft(room);
      next.issueIds = Array.from(new Set([...requiredIssueIds, ...next.issueIds]));
      setDraft(next);
    }
  }, [open, room, requiredIssueIds]);

  const leaderIds = useMemo(() => collectLeaderIds(hierarchy), [hierarchy]);
  const executiveIds = useMemo(() => collectExecutiveIds(hierarchy), [hierarchy]);
  const bulkGroups = useMemo(() => conferenceRoomLeadershipBulkGroups(hierarchy), [hierarchy]);
  const clusterLeadershipGroups = useMemo(
    () =>
      (hierarchy.portfolioClusters ?? [])
        .map((cluster) => ({
          clusterId: cluster.clusterId,
          name: cluster.name,
          leaders: Array.from(new Map([
            ...(cluster.portfolioDirector ? [[cluster.portfolioDirector.id, cluster.portfolioDirector] as const] : []),
            ...cluster.projects.flatMap((project) =>
              project.leadership.map((leader) => [leader.id, leader] as const),
            ),
          ]).values()),
        }))
        .filter((cluster) => cluster.leaders.length > 0),
    [hierarchy],
  );

  function toggleIssue(issueId: string, checked: boolean) {
    setDraft((current) => ({
      ...current,
      issueIds: checked
        ? Array.from(new Set([...current.issueIds, issueId]))
        : current.issueIds.filter((value) => value !== issueId || requiredIssueIds.includes(value)),
    }));
  }

  function toggleParticipant(agentId: string, checked: boolean) {
    setDraft((current) => ({
      ...current,
      participantAgentIds: checked
        ? Array.from(new Set([...current.participantAgentIds, agentId]))
        : current.participantAgentIds.filter((value) => value !== agentId),
    }));
  }

  async function submit() {
    if (!draft.title.trim() || !draft.summary.trim()) return;
    await onSubmit({
      title: draft.title.trim(),
      summary: draft.summary.trim(),
      agenda: draft.agenda.trim() ? draft.agenda.trim() : null,
      issueIds: Array.from(new Set([...requiredIssueIds, ...draft.issueIds])),
      participantAgentIds: draft.participantAgentIds,
    });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !isPending && onOpenChange(next)}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{room ? "Edit conference room" : "Open conference room"}</DialogTitle>
          <DialogDescription>
            Define the room, optionally link issues, and invite executives, project leadership, or shared-service leads.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="conference-room-title">Title</Label>
              <Input
                id="conference-room-title"
                value={draft.title}
                onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                placeholder="Cross-functional review of launch blockers"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="conference-room-summary">Summary</Label>
              <Input
                id="conference-room-summary"
                value={draft.summary}
                onChange={(event) => setDraft((current) => ({ ...current, summary: event.target.value }))}
                placeholder="What decision or discussion is this room for?"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="conference-room-agenda">Agenda</Label>
            <Textarea
              id="conference-room-agenda"
              value={draft.agenda}
              onChange={(event) => setDraft((current) => ({ ...current, agenda: event.target.value }))}
              placeholder="Topics, checkpoints, and desired outcome."
            />
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Linked issues</p>
                <p className="text-xs text-muted-foreground">
                  Repo context is captured on board-decision requests only when exactly one issue is linked.
                </p>
              </div>
            </div>
            <div className="grid gap-2 rounded-xl border border-border/60 p-3">
              {issues.length === 0 ? (
                <p className="text-sm text-muted-foreground">No issues available.</p>
              ) : (
                issues.map((issue) => {
                  const checked = draft.issueIds.includes(issue.id);
                  const required = requiredIssueIds.includes(issue.id);
                  return (
                    <label key={issue.id} className="flex items-start gap-3 rounded-lg border border-border/60 px-3 py-2">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(next) => toggleIssue(issue.id, next === true)}
                        disabled={required}
                      />
                      <span className="min-w-0 text-sm">
                        <span className="font-medium">{issue.identifier ?? issue.id.slice(0, 8)}</span>
                        <span className="mx-2 text-muted-foreground">{issue.title}</span>
                      </span>
                    </label>
                  );
                })
              )}
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">Invite leaders</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setDraft((current) => ({ ...current, participantAgentIds: leaderIds }))}
              >
                All leaders
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setDraft((current) => ({ ...current, participantAgentIds: executiveIds }))}
              >
                All executives
              </Button>
              {bulkGroups.map((group) => (
                <Button
                  key={group.key}
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setDraft((current) => ({
                    ...current,
                    participantAgentIds: Array.from(new Set([...current.participantAgentIds, ...group.agentIds])),
                  }))}
                >
                  {group.label}
                </Button>
              ))}
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              {hierarchy.executiveOffice.length > 0 ? (
                <div className="space-y-2 rounded-xl border border-border/60 p-3">
                  <p className="text-sm font-medium">Executive Office</p>
                  {hierarchy.executiveOffice.map((leader) => (
                    <label key={leader.id} className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2">
                      <Checkbox
                        checked={draft.participantAgentIds.includes(leader.id)}
                        onCheckedChange={(next) => toggleParticipant(leader.id, next === true)}
                      />
                      <span className="text-sm">{leader.name}</span>
                    </label>
                  ))}
                </div>
              ) : null}

              {clusterLeadershipGroups.length > 0
                ? clusterLeadershipGroups.map((cluster) => (
                    <div key={cluster.clusterId} className="space-y-2 rounded-xl border border-border/60 p-3">
                      <p className="text-sm font-medium">{cluster.name}</p>
                      {cluster.leaders.map((leader) => (
                        <label key={leader.id} className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2">
                          <Checkbox
                            checked={draft.participantAgentIds.includes(leader.id)}
                            onCheckedChange={(next) => toggleParticipant(leader.id, next === true)}
                          />
                          <span className="text-sm">{leader.name}</span>
                        </label>
                      ))}
                    </div>
                  ))
                : hierarchy.projectPods.map((project) =>
                    project.leadership.length > 0 ? (
                      <div key={project.projectId} className="space-y-2 rounded-xl border border-border/60 p-3">
                        <p className="text-sm font-medium">{project.projectName}</p>
                        {project.leadership.map((leader) => (
                          <label key={leader.id} className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2">
                            <Checkbox
                              checked={draft.participantAgentIds.includes(leader.id)}
                              onCheckedChange={(next) => toggleParticipant(leader.id, next === true)}
                            />
                            <span className="text-sm">{leader.name}</span>
                          </label>
                        ))}
                      </div>
                    ) : null,
                  )}
            </div>

            {hierarchy.sharedServices.length > 0 ? (
              <div className="space-y-2 rounded-xl border border-border/60 p-3">
                <p className="text-sm font-medium">Shared Service Leads</p>
                {hierarchy.sharedServices.flatMap((department) => department.leaders).map((leader) => (
                  <label key={leader.id} className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2">
                    <Checkbox
                      checked={draft.participantAgentIds.includes(leader.id)}
                      onCheckedChange={(next) => toggleParticipant(leader.id, next === true)}
                    />
                    <span className="text-sm">{leader.name}</span>
                  </label>
                ))}
              </div>
            ) : null}

            {hierarchy.unassigned.length > 0 ? (
              <div className="space-y-2 rounded-xl border border-border/60 p-3">
                <p className="text-sm font-medium">Unassigned leaders</p>
                {hierarchy.unassigned.map((leader) => (
                  <label key={leader.id} className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2">
                    <Checkbox
                      checked={draft.participantAgentIds.includes(leader.id)}
                      onCheckedChange={(next) => toggleParticipant(leader.id, next === true)}
                    />
                    <span className="text-sm">{leader.name}</span>
                  </label>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={isPending || !draft.title.trim() || !draft.summary.trim()}>
            {isPending ? "Saving..." : room ? "Save room" : "Create room"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

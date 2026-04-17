import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquareShare, ShieldCheck } from "lucide-react";
import { getConferenceRoomKindDescriptor } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { conferenceRoomsApi } from "../api/conferenceRooms";
import { issuesApi } from "../api/issues";
import { ConferenceRoomEditorDialog } from "../components/ConferenceRoomEditorDialog";
import { PageSkeleton } from "../components/PageSkeleton";
import { PageTabBar } from "../components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";

type StatusFilter = "open" | "all";

function roomIsActionable(status: string) {
  return status === "open";
}

export function ConferenceRoom() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { pushToast } = useToast();
  const pathSegment = location.pathname.split("/").pop() ?? "open";
  const statusFilter: StatusFilter = pathSegment === "all" ? "all" : "open";
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Conference Room" }]);
  }, [setBreadcrumbs]);

  const { data: rooms, isLoading, error } = useQuery({
    queryKey: queryKeys.conferenceRooms.list(selectedCompanyId!),
    queryFn: () => conferenceRoomsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: hierarchy } = useQuery({
    queryKey: queryKeys.agents.operatingHierarchy(selectedCompanyId!),
    queryFn: () => agentsApi.operatingHierarchy(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!, { limit: 200 }),
    enabled: !!selectedCompanyId,
  });

  const createRoom = useMutation({
    mutationFn: (data: Parameters<typeof conferenceRoomsApi.create>[1]) =>
      conferenceRoomsApi.create(selectedCompanyId!, data),
    onSuccess: (room) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.conferenceRooms.list(selectedCompanyId!) });
      setCreateOpen(false);
      navigate(`/conference-room/rooms/${room.id}`);
    },
    onError: (err) => {
      pushToast({
        title: "Room creation failed",
        body: err instanceof Error ? err.message : "Unable to create conference room",
        tone: "error",
      });
    },
  });

  const filteredRooms = useMemo(
    () =>
      (rooms ?? [])
        .filter((room) => statusFilter === "all" || roomIsActionable(room.status))
        .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()),
    [rooms, statusFilter],
  );

  const openCount = (rooms ?? []).filter((room) => roomIsActionable(room.status)).length;

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground">Select a company first.</p>;
  }

  if (isLoading) {
    return <PageSkeleton variant="approvals" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <MessageSquareShare className="h-4 w-4 text-muted-foreground" />
            <h1 className="text-base font-semibold">Conference Room</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Open company-level conference rooms anytime, invite the agents who should participate, and escalate formal board decisions from inside the room.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <MessageSquareShare className="mr-1.5 h-4 w-4" />
          New room
        </Button>
      </div>

      <Tabs value={statusFilter} onValueChange={(value) => navigate(`/conference-room/${value}`)}>
        <PageTabBar
          items={[
            {
              value: "open",
              label: (
                <>
                  Open
                  {openCount > 0 ? (
                    <span className="ml-1.5 rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-300">
                      {openCount}
                    </span>
                  ) : null}
                </>
              ),
            },
            { value: "all", label: "All" },
          ]}
        />
      </Tabs>

      {error ? <p className="text-sm text-destructive">{error.message}</p> : null}

      {filteredRooms.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/70 py-16 text-center">
          <ShieldCheck className="mb-3 h-8 w-8 text-muted-foreground/30" />
          <p className="text-sm font-medium text-foreground">
            {statusFilter === "open" ? "No open conference rooms." : "No conference rooms yet."}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Open a room when work needs coordinated discussion and an optional later board decision.
          </p>
        </div>
      ) : (
        <div className="grid gap-3">
          {filteredRooms.map((room) => (
            <Link
              key={room.id}
              to={`/conference-room/rooms/${room.id}`}
              className="rounded-xl border border-border/70 bg-card/70 p-4 transition-colors hover:bg-accent/20"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-base font-semibold">{room.title}</span>
                    <span className="rounded-full border border-border px-2 py-0.5 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                      {room.status}
                    </span>
                    <span className="rounded-full border border-border/60 bg-background/70 px-2 py-0.5 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                      {getConferenceRoomKindDescriptor(room.kind)?.label ?? "Legacy room"}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground">{room.summary}</p>
                  {room.linkedIssues.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {room.linkedIssues.map((issue) => (
                        <span
                          key={issue.issueId}
                          className="rounded-full border border-border/60 bg-background/70 px-2.5 py-1 text-xs text-muted-foreground"
                        >
                          {issue.identifier ?? issue.issueId.slice(0, 8)}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="grid grid-cols-3 gap-2 text-right text-xs text-muted-foreground">
                  <div>
                    <div className="font-medium text-foreground">{room.participants.length}</div>
                    <div>participants</div>
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
              {room.linkedIssues.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {room.linkedIssues.slice(0, 3).map((issue) => (
                    <span key={issue.issueId} className="text-xs text-muted-foreground">
                      {issue.title}
                    </span>
                  ))}
                </div>
              ) : null}
            </Link>
          ))}
        </div>
      )}

      {hierarchy && issues ? (
        <ConferenceRoomEditorDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          hierarchy={hierarchy}
          issues={issues}
          isPending={createRoom.isPending}
          onSubmit={async (draft) => {
            await createRoom.mutateAsync(draft);
          }}
        />
      ) : null}
    </div>
  );
}

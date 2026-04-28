import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SharedSkillProposal, SharedSkillProposalStatus } from "@paperclipai/shared";
import { AlertTriangle, CheckCircle2, GitPullRequest, Layers3, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Link, useNavigate, useParams } from "@/lib/router";
import { sharedSkillsApi } from "@/api/sharedSkills";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

function statusClassName(status: SharedSkillProposalStatus) {
  if (status === "approved") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200";
  if (status === "pending") return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-200";
  if (status === "revision_requested") return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-200";
  return "border-border bg-background/80 text-muted-foreground";
}

function splitList(value: string) {
  return Array.from(
    new Set(
      value
        .split(/\r?\n|,/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
}

function VerificationBucket({
  label,
  required,
  actual,
}: {
  label: string;
  required: string[];
  actual: string[];
}) {
  const complete = required.every((item) => actual.includes(item));
  return (
    <div className="rounded-md border border-border px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">{label}</div>
        <span className={cn("rounded-full border px-2 py-0.5 text-[10px] uppercase", complete ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200" : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-200")}>
          {complete ? "complete" : "pending"}
        </span>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Required</div>
          <ul className="mt-2 space-y-1 text-sm">
            {required.length > 0 ? required.map((item) => <li key={item}>• {item}</li>) : <li className="text-muted-foreground">None</li>}
          </ul>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Reported</div>
          <ul className="mt-2 space-y-1 text-sm">
            {actual.length > 0 ? actual.map((item) => <li key={item}>• {item}</li>) : <li className="text-muted-foreground">None</li>}
          </ul>
        </div>
      </div>
    </div>
  );
}

function proposalReadyForApproval(proposal: SharedSkillProposal) {
  const required = proposal.payload.requiredVerification;
  const results = proposal.payload.verificationResults;
  if (!required) return true;
  if (!results) return false;
  const containsAll = (need: string[], actual: string[]) => need.every((item) => actual.includes(item));
  return (
    containsAll(required.unitCommands, results.passedUnitCommands)
    && containsAll(required.integrationCommands, results.passedIntegrationCommands)
    && containsAll(required.promptfooCaseIds, results.passedPromptfooCaseIds)
    && containsAll(required.architectureScenarioIds, results.passedArchitectureScenarioIds)
    && containsAll(required.smokeChecklist, results.completedSmokeChecklist)
  );
}

function proposalHasRequiredVerification(proposal: SharedSkillProposal) {
  const required = proposal.payload.requiredVerification;
  return Boolean(
    required
    && (
      required.unitCommands.length > 0
      || required.integrationCommands.length > 0
      || required.promptfooCaseIds.length > 0
      || required.architectureScenarioIds.length > 0
      || required.smokeChecklist.length > 0
    ),
  );
}

function proposalMissingEvidence(proposal: SharedSkillProposal) {
  return proposal.kind === "self_improvement"
    && (!proposal.payload.evidence.issueId || !proposal.payload.evidence.runId);
}

function isLiteralTestProposal(proposal: SharedSkillProposal) {
  const text = `${proposal.summary} ${proposal.rationale}`.toLowerCase();
  return /\b(test|dummy|example)\b/.test(text) && proposal.payload.changes.length <= 1;
}

export function InstanceSharedSkills() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { proposalId } = useParams<{ proposalId?: string }>();
  const [statusFilter, setStatusFilter] = useState<"all" | SharedSkillProposalStatus>("all");
  const [decisionNote, setDecisionNote] = useState("");
  const [unitText, setUnitText] = useState("");
  const [integrationText, setIntegrationText] = useState("");
  const [promptfooText, setPromptfooText] = useState("");
  const [architectureText, setArchitectureText] = useState("");
  const [smokeText, setSmokeText] = useState("");

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance Settings", href: "/instance/settings/general" },
      { label: "Shared Skills", href: "/instance/settings/shared-skills" },
      ...(proposalId ? [{ label: proposalId }] : []),
    ]);
  }, [proposalId, setBreadcrumbs]);

  const proposalsQuery = useQuery({
    queryKey: queryKeys.instance.sharedSkillProposals(statusFilter === "all" ? undefined : statusFilter),
    queryFn: () => sharedSkillsApi.listProposals(statusFilter === "all" ? undefined : statusFilter),
  });

  const selectedProposalId = useMemo(
    () => proposalId ?? proposalsQuery.data?.[0]?.id ?? null,
    [proposalId, proposalsQuery.data],
  );

  const detailQuery = useQuery({
    queryKey: selectedProposalId ? queryKeys.instance.sharedSkillProposal(selectedProposalId) : ["instance", "shared-skills", "proposal", "missing"],
    queryFn: () => sharedSkillsApi.getProposal(selectedProposalId!),
    enabled: Boolean(selectedProposalId),
  });

  const invalidate = async (currentProposalId: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.instance.sharedSkillProposals(statusFilter === "all" ? undefined : statusFilter) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.instance.sharedSkillProposal(currentProposalId) }),
    ]);
  };

  const verificationMutation = useMutation({
    mutationFn: () =>
      sharedSkillsApi.updateProposalVerification(selectedProposalId!, {
        passedUnitCommands: splitList(unitText),
        passedIntegrationCommands: splitList(integrationText),
        passedPromptfooCaseIds: splitList(promptfooText),
        passedArchitectureScenarioIds: splitList(architectureText),
        completedSmokeChecklist: splitList(smokeText),
      }),
    onSuccess: async (proposal) => {
      await invalidate(proposal.id);
      setUnitText("");
      setIntegrationText("");
      setPromptfooText("");
      setArchitectureText("");
      setSmokeText("");
      pushToast({ tone: "success", title: "Verification updated", body: proposal.summary });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Verification update failed",
        body: error instanceof Error ? error.message : "Failed to update proposal verification.",
      });
    },
  });

  const approveMutation = useMutation({
    mutationFn: () => sharedSkillsApi.approveProposal(selectedProposalId!, decisionNote.trim() || null),
    onSuccess: async (proposal) => {
      await invalidate(proposal.id);
      setDecisionNote("");
      pushToast({ tone: "success", title: "Proposal approved", body: proposal.summary });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Approval failed",
        body: error instanceof Error ? error.message : "Failed to approve shared-skill proposal.",
      });
    },
  });

  const requestRevisionMutation = useMutation({
    mutationFn: () => sharedSkillsApi.requestRevision(selectedProposalId!, decisionNote.trim() || null),
    onSuccess: async (proposal) => {
      await invalidate(proposal.id);
      setDecisionNote("");
      pushToast({ tone: "success", title: "Revision requested", body: proposal.summary });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Revision request failed",
        body: error instanceof Error ? error.message : "Failed to request proposal revision.",
      });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: () => sharedSkillsApi.rejectProposal(selectedProposalId!, decisionNote.trim() || null),
    onSuccess: async (proposal) => {
      await invalidate(proposal.id);
      setDecisionNote("");
      pushToast({ tone: "success", title: "Proposal rejected", body: proposal.summary });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Reject failed",
        body: error instanceof Error ? error.message : "Failed to reject shared-skill proposal.",
      });
    },
  });

  useEffect(() => {
    if (!proposalId && proposalsQuery.data?.[0]?.id) {
      navigate(`/instance/settings/shared-skills/${proposalsQuery.data[0].id}`, { replace: true });
    }
  }, [navigate, proposalId, proposalsQuery.data]);

  const proposal = detailQuery.data ?? null;
  const readyForApproval = proposal ? proposalReadyForApproval(proposal) : false;
  const proposals = proposalsQuery.data ?? [];
  const duplicateOpenSharedSkillIds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of proposals) {
      if (entry.status !== "pending" && entry.status !== "revision_requested") continue;
      counts.set(entry.sharedSkillId, (counts.get(entry.sharedSkillId) ?? 0) + 1);
    }
    return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([sharedSkillId]) => sharedSkillId));
  }, [proposals]);
  const actionSummary = useMemo(() => {
    const open = proposals.filter((entry) => entry.status === "pending" || entry.status === "revision_requested");
    return {
      readyToApprove: open.filter((entry) => entry.status === "pending" && proposalReadyForApproval(entry) && proposalHasRequiredVerification(entry) && !proposalMissingEvidence(entry)),
      missingVerification: open.filter((entry) => !proposalHasRequiredVerification(entry) || !proposalReadyForApproval(entry) || proposalMissingEvidence(entry)),
      stalePatchBase: open.filter((entry) => (entry.decisionNote ?? "").toLowerCase().includes("mirror changed")),
      duplicateOrSuperseded: open.filter((entry) => duplicateOpenSharedSkillIds.has(entry.sharedSkillId) || Boolean(entry.payload.supersedesProposalId)),
      noLinkedIssue: open.filter((entry) => proposalMissingEvidence(entry)),
      literalTests: open.filter((entry) => isLiteralTestProposal(entry)),
    };
  }, [duplicateOpenSharedSkillIds, proposals]);

  const invalidateProposalLists = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.instance.sharedSkillProposals(statusFilter === "all" ? undefined : statusFilter) }),
      selectedProposalId
        ? queryClient.invalidateQueries({ queryKey: queryKeys.instance.sharedSkillProposal(selectedProposalId) })
        : Promise.resolve(),
    ]);
  };

  const batchApproveMutation = useMutation({
    mutationFn: async () => {
      await Promise.all(actionSummary.readyToApprove.map((entry) =>
        sharedSkillsApi.approveProposal(entry.id, "Batch approved: required verification is complete.")));
    },
    onSuccess: async () => {
      await invalidateProposalLists();
      pushToast({ tone: "success", title: "Batch approval complete", body: `${actionSummary.readyToApprove.length} proposal${actionSummary.readyToApprove.length === 1 ? "" : "s"} approved.` });
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "Batch approval failed", body: error instanceof Error ? error.message : "Failed to approve verified proposals." });
    },
  });

  const batchRevisionMutation = useMutation({
    mutationFn: async () => {
      await Promise.all(actionSummary.missingVerification.map((entry) =>
        sharedSkillsApi.requestRevision(entry.id, "Batch revision requested: complete required verification and issue/run evidence before board review.")));
    },
    onSuccess: async () => {
      await invalidateProposalLists();
      pushToast({ tone: "success", title: "Batch revision requested", body: `${actionSummary.missingVerification.length} proposal${actionSummary.missingVerification.length === 1 ? "" : "s"} returned for evidence.` });
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "Batch revision failed", body: error instanceof Error ? error.message : "Failed to request revisions." });
    },
  });

  const batchRejectTestsMutation = useMutation({
    mutationFn: async () => {
      await Promise.all(actionSummary.literalTests.map((entry) =>
        sharedSkillsApi.rejectProposal(entry.id, "Batch rejected: literal test/dummy proposal.")));
    },
    onSuccess: async () => {
      await invalidateProposalLists();
      pushToast({ tone: "success", title: "Batch rejection complete", body: `${actionSummary.literalTests.length} test proposal${actionSummary.literalTests.length === 1 ? "" : "s"} rejected.` });
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "Batch rejection failed", body: error instanceof Error ? error.message : "Failed to reject test proposals." });
    },
  });

  if (proposalsQuery.isLoading || (selectedProposalId && detailQuery.isLoading)) {
    return <div className="text-sm text-muted-foreground">Loading shared-skill proposals...</div>;
  }

  if (proposalsQuery.error || detailQuery.error) {
    const error = proposalsQuery.error ?? detailQuery.error;
    return <div className="text-sm text-destructive">{error instanceof Error ? error.message : "Failed to load shared-skill proposals."}</div>;
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
      <aside className="rounded-xl border border-border bg-card">
        <div className="border-b border-border px-4 py-4">
          <div className="flex items-center gap-2">
            <GitPullRequest className="h-4 w-4 text-muted-foreground" />
            <h1 className="text-base font-semibold">Shared Skill Proposals</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Review shared-skill changes and verify the required reliability evidence before approval.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {(["all", "pending", "revision_requested", "approved"] as const).map((status) => (
              <Button
                key={status}
                variant={statusFilter === status ? "default" : "outline"}
                size="sm"
                onClick={() => setStatusFilter(status)}
              >
                {status === "all" ? "All" : status.replaceAll("_", " ")}
              </Button>
            ))}
          </div>
        </div>
        <div className="divide-y">
          {(proposalsQuery.data ?? []).length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">No shared-skill proposals match this filter.</div>
          ) : (
            (proposalsQuery.data ?? []).map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => navigate(`/instance/settings/shared-skills/${entry.id}`)}
                className={cn(
                  "w-full px-4 py-3 text-left transition-colors hover:bg-accent/20",
                  selectedProposalId === entry.id && "bg-accent/30",
                )}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-foreground">{entry.summary}</div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">{entry.kind.replaceAll("_", " ")}</div>
                  </div>
                  <span className={cn("rounded-full border px-2 py-0.5 text-[10px] uppercase", statusClassName(entry.status))}>
                    {entry.status.replaceAll("_", " ")}
                  </span>
                </div>
              </button>
            ))
          )}
        </div>
      </aside>

      <div className="min-w-0">
        <section className="mb-6 rounded-xl border border-border bg-card px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <Layers3 className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-base font-semibold">Needs action</h2>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Batch only safe catalog-maintenance decisions. Incomplete verification should return before board review.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => batchApproveMutation.mutate()}
                disabled={actionSummary.readyToApprove.length === 0 || batchApproveMutation.isPending}
              >
                Approve ready ({actionSummary.readyToApprove.length})
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => batchRevisionMutation.mutate()}
                disabled={actionSummary.missingVerification.length === 0 || batchRevisionMutation.isPending}
              >
                Request verification ({actionSummary.missingVerification.length})
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => batchRejectTestsMutation.mutate()}
                disabled={actionSummary.literalTests.length === 0 || batchRejectTestsMutation.isPending}
              >
                Reject tests ({actionSummary.literalTests.length})
              </Button>
            </div>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-5">
            {[
              ["Ready", actionSummary.readyToApprove.length],
              ["Missing verification", actionSummary.missingVerification.length],
              ["Stale patch base", actionSummary.stalePatchBase.length],
              ["Duplicate/superseded", actionSummary.duplicateOrSuperseded.length],
              ["No linked issue", actionSummary.noLinkedIssue.length],
            ].map(([label, count]) => (
              <div key={label} className="rounded-md border border-border px-3 py-3">
                <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{label}</div>
                <div className="mt-2 text-lg font-semibold">{count}</div>
              </div>
            ))}
          </div>
        </section>
        {!proposal ? (
          <div className="rounded-xl border border-border bg-card px-5 py-6 text-sm text-muted-foreground">
            Select a proposal to review its evidence and verification state.
          </div>
        ) : (
          <div className="space-y-6">
            <section className="rounded-xl border border-border bg-card px-5 py-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-semibold">{proposal.summary}</h2>
                    <span className={cn("rounded-full border px-2 py-0.5 text-[10px] uppercase", statusClassName(proposal.status))}>
                      {proposal.status.replaceAll("_", " ")}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">{proposal.rationale}</p>
                </div>
                <div className="rounded-md border border-border px-3 py-3 text-sm">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Proposal ID</div>
                  <div className="mt-1 font-mono text-xs">{proposal.id}</div>
                </div>
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div className="rounded-md border border-border px-3 py-3">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Evidence</div>
                  <ul className="mt-2 space-y-1 text-sm">
                    <li>Run: {proposal.payload.evidence.runId ?? "none"}</li>
                    <li>Issue: {proposal.payload.evidence.issueId ?? "none"}</li>
                    <li>Fingerprint: {proposal.payload.evidence.failureFingerprint ?? "none"}</li>
                  </ul>
                  {proposal.payload.evidence.reproductionSummary ? (
                    <p className="mt-3 text-sm text-muted-foreground">{proposal.payload.evidence.reproductionSummary}</p>
                  ) : null}
                </div>
                <div className="rounded-md border border-border px-3 py-3">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Next step</div>
                  <div className="mt-2 flex items-center gap-2 text-sm">
                    {readyForApproval && proposalHasRequiredVerification(proposal) && !proposalMissingEvidence(proposal) ? (
                      <>
                        <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                        Verification is complete and approval can proceed.
                      </>
                    ) : (
                      <>
                        <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                        Verification or source evidence is incomplete.
                      </>
                    )}
                  </div>
                  <div className="mt-3 text-xs text-muted-foreground">
                    Mirror digest gate still applies on approval. Verification only clears the reliability requirement.
                  </div>
                </div>
              </div>
            </section>

            <section className="rounded-xl border border-border bg-card px-5 py-5">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-base font-semibold">Required Verification</h3>
              </div>
              <div className="mt-4 grid gap-4">
                <VerificationBucket
                  label="Unit commands"
                  required={proposal.payload.requiredVerification?.unitCommands ?? []}
                  actual={proposal.payload.verificationResults?.passedUnitCommands ?? []}
                />
                <VerificationBucket
                  label="Integration commands"
                  required={proposal.payload.requiredVerification?.integrationCommands ?? []}
                  actual={proposal.payload.verificationResults?.passedIntegrationCommands ?? []}
                />
                <VerificationBucket
                  label="Promptfoo cases"
                  required={proposal.payload.requiredVerification?.promptfooCaseIds ?? []}
                  actual={proposal.payload.verificationResults?.passedPromptfooCaseIds ?? []}
                />
                <VerificationBucket
                  label="Architecture scenarios"
                  required={proposal.payload.requiredVerification?.architectureScenarioIds ?? []}
                  actual={proposal.payload.verificationResults?.passedArchitectureScenarioIds ?? []}
                />
                <VerificationBucket
                  label="Smoke checklist"
                  required={proposal.payload.requiredVerification?.smokeChecklist ?? []}
                  actual={proposal.payload.verificationResults?.completedSmokeChecklist ?? []}
                />
              </div>
            </section>

            <section className="rounded-xl border border-border bg-card px-5 py-5">
              <h3 className="text-base font-semibold">Append Verification Results</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Enter one item per line or use commas. Results append to the current proposal payload.
              </p>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <Textarea value={unitText} onChange={(event) => setUnitText(event.target.value)} placeholder="passed unit commands" className="min-h-[88px]" />
                <Textarea value={integrationText} onChange={(event) => setIntegrationText(event.target.value)} placeholder="passed integration commands" className="min-h-[88px]" />
                <Textarea value={promptfooText} onChange={(event) => setPromptfooText(event.target.value)} placeholder="passed promptfoo case ids" className="min-h-[88px]" />
                <Textarea value={architectureText} onChange={(event) => setArchitectureText(event.target.value)} placeholder="passed architecture scenario ids" className="min-h-[88px]" />
                <Textarea value={smokeText} onChange={(event) => setSmokeText(event.target.value)} placeholder="completed smoke checklist items" className="min-h-[88px] md:col-span-2" />
              </div>
              <div className="mt-4">
                <Button
                  onClick={() => verificationMutation.mutate()}
                  disabled={
                    verificationMutation.isPending
                    || [unitText, integrationText, promptfooText, architectureText, smokeText].every((value) => value.trim().length === 0)
                  }
                >
                  {verificationMutation.isPending ? "Updating..." : "Append verification"}
                </Button>
              </div>
            </section>

            <section className="rounded-xl border border-border bg-card px-5 py-5">
              <h3 className="text-base font-semibold">Decision</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Approval stays disabled until the required verification lists are fully covered.
              </p>
              <Textarea
                value={decisionNote}
                onChange={(event) => setDecisionNote(event.target.value)}
                placeholder="Optional decision note"
                className="mt-4 min-h-[96px]"
              />
              <div className="mt-4 flex flex-wrap gap-2">
                <Button onClick={() => approveMutation.mutate()} disabled={approveMutation.isPending || !readyForApproval || !proposalHasRequiredVerification(proposal) || proposalMissingEvidence(proposal)}>
                  {approveMutation.isPending ? "Approving..." : "Approve"}
                </Button>
                <Button variant="outline" onClick={() => requestRevisionMutation.mutate()} disabled={requestRevisionMutation.isPending}>
                  {requestRevisionMutation.isPending ? "Requesting..." : "Request revision"}
                </Button>
                <Button variant="outline" onClick={() => rejectMutation.mutate()} disabled={rejectMutation.isPending}>
                  {rejectMutation.isPending ? "Rejecting..." : "Reject"}
                </Button>
                {proposal.companyId && proposal.issueId ? (
                  <Link to={`/issues/${proposal.issueId}`} className="inline-flex items-center text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground">
                    Open source issue
                  </Link>
                ) : null}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

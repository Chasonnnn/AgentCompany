import { useEffect, useMemo, useState } from "react";
import {
  AGENT_DEPARTMENT_LABELS,
  type Agent,
  type CompanyDocument,
  type TeamDocument,
  getReservedCompanyDocumentDescriptor,
  getReservedTeamDocumentDescriptor,
} from "@paperclipai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpenText, History, Save } from "lucide-react";
import { companiesApi } from "@/api/companies";
import { agentsApi } from "@/api/agents";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { useLocation, useNavigate } from "@/lib/router";

type CompanyDocTarget = {
  kind: "company";
  key: "company";
  id: string;
  label: string;
  hash: string;
};

type TeamDocTarget = {
  kind: "team";
  departmentKey: Agent["departmentKey"];
  departmentName: string | null;
  key: "team";
  id: string;
  label: string;
  hash: string;
};

type DocTarget = CompanyDocTarget | TeamDocTarget;

function slugify(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function teamHash(departmentKey: string, departmentName: string | null) {
  const scope = departmentKey === "custom" ? `${departmentKey}-${departmentName ?? "team"}` : departmentKey;
  return `#team-document-${slugify(scope)}`;
}

function departmentLabel(departmentKey: Agent["departmentKey"], departmentName: string | null) {
  if (departmentKey === "custom") return departmentName?.trim() || "Custom";
  return AGENT_DEPARTMENT_LABELS[departmentKey];
}

function buildCompanyTemplate(companyName: string) {
  return [
    "# COMPANY.md",
    "",
    "## Charter",
    "",
    `- Company: ${companyName}`,
    "- Goal: State the company goal and why this operating model exists.",
    "",
    "## Escalation Matrix",
    "",
    "- Board: High-impact direction, staffing, budget, or trust decisions.",
    "- CEO: Company-wide prioritization, kickoff sponsorship, and approvals routing.",
    "",
    "## Budget Regime",
    "",
    "- Company monthly budget: $50",
    "- Default onboarding project budget: $25",
    "- Default starter-agent budget: $10",
    "",
    "## Approval Regime",
    "",
    "- Conference-room discussion coordinates work; approvals resolve material direction changes.",
    "",
    "## Sandbox And Trust",
    "",
    "- Document the default runtime trust posture, approval expectations, and escalation rules.",
  ].join("\n");
}

function buildTeamTemplate(label: string) {
  return [
    "# TEAM.md",
    "",
    "## Charter",
    "",
    `- Team: ${label}`,
    "- Scope: Define what this department owns and what it should escalate.",
    "",
    "## Operating Rhythm",
    "",
    "- Kickoff participation, review cadence, and routine ownership.",
    "",
    "## Artifacts",
    "",
    "- Which durable docs, checklists, or room outputs this team curates.",
    "",
    "## Risks And Escalations",
    "",
    "- What should be escalated, to whom, and with what evidence.",
  ].join("\n");
}

function toTargetId(target: DocTarget) {
  return target.kind === "company"
    ? `${target.kind}:${target.key}`
    : `${target.kind}:${target.departmentKey}:${target.departmentName ?? ""}:${target.key}`;
}

export function CompanySettingsDocs() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState("");

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Docs" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const agentsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.agents.list(selectedCompanyId) : ["agents", "__disabled__"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const companyDocumentsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.companies.documents(selectedCompanyId) : ["company-docs", "__disabled__"],
    queryFn: () => companiesApi.listDocuments(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const teamDocumentsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.companies.teamDocuments(selectedCompanyId) : ["team-docs", "__disabled__"],
    queryFn: () => companiesApi.listTeamDocuments(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const documentTargets = useMemo<DocTarget[]>(() => {
    const targets: DocTarget[] = [
      {
        kind: "company",
        key: "company",
        id: "company:company",
        label: getReservedCompanyDocumentDescriptor("company")?.label ?? "COMPANY.md",
        hash: "#document-company",
      },
    ];

    const teamScopes = new Map<string, { departmentKey: Agent["departmentKey"]; departmentName: string | null }>();
    for (const agent of agentsQuery.data ?? []) {
      const key = `${agent.departmentKey}:${agent.departmentName ?? ""}`;
      teamScopes.set(key, {
        departmentKey: agent.departmentKey,
        departmentName: agent.departmentKey === "custom" ? agent.departmentName ?? null : null,
      });
    }
    for (const doc of teamDocumentsQuery.data ?? []) {
      const key = `${doc.departmentKey}:${doc.departmentName ?? ""}`;
      teamScopes.set(key, {
        departmentKey: doc.departmentKey,
        departmentName: doc.departmentName ?? null,
      });
    }

    const teamEntries = Array.from(teamScopes.values())
      .sort((left, right) => departmentLabel(left.departmentKey, left.departmentName).localeCompare(
        departmentLabel(right.departmentKey, right.departmentName),
      ))
      .map<DocTarget>((scope) => ({
        kind: "team",
        departmentKey: scope.departmentKey,
        departmentName: scope.departmentName,
        key: "team",
        id: `team:${scope.departmentKey}:${scope.departmentName ?? ""}:team`,
        label: `${departmentLabel(scope.departmentKey, scope.departmentName)} ${getReservedTeamDocumentDescriptor("team")?.label ?? "TEAM.md"}`,
        hash: teamHash(scope.departmentKey, scope.departmentName),
      }));

    return [...targets, ...teamEntries];
  }, [agentsQuery.data, teamDocumentsQuery.data]);

  useEffect(() => {
    if (documentTargets.length === 0) return;
    const matchedByHash = documentTargets.find((target) => target.hash === location.hash) ?? null;
    const nextTarget = matchedByHash ?? documentTargets[0] ?? null;
    if (nextTarget && nextTarget.id !== selectedId) {
      setSelectedId(nextTarget.id);
    }
  }, [documentTargets, location.hash, selectedId]);

  const selectedTarget = useMemo(
    () => documentTargets.find((target) => target.id === selectedId) ?? null,
    [documentTargets, selectedId],
  );
  const selectedCompanyTarget = selectedTarget?.kind === "company" ? selectedTarget : null;
  const selectedTeamTarget = selectedTarget?.kind === "team" ? selectedTarget : null;

  const companyDocumentQuery = useQuery({
    queryKey: selectedCompanyId && selectedCompanyTarget
      ? queryKeys.companies.document(selectedCompanyId, selectedCompanyTarget.key)
      : ["company-document", "__disabled__"],
    queryFn: () => companiesApi.getDocument(selectedCompanyId!, "company"),
    enabled: !!selectedCompanyId && !!selectedCompanyTarget,
  });

  const teamDocumentQuery = useQuery({
    queryKey: selectedCompanyId && selectedTeamTarget
      ? queryKeys.companies.teamDocument(
        selectedCompanyId,
        selectedTeamTarget.departmentKey,
        selectedTeamTarget.departmentName,
        selectedTeamTarget.key,
      )
      : ["team-document", "__disabled__"],
    queryFn: () =>
      companiesApi.getTeamDocument(
        selectedCompanyId!,
        selectedTeamTarget!.departmentKey,
        "team",
        selectedTeamTarget!.departmentName,
      ),
    enabled: !!selectedCompanyId && !!selectedTeamTarget,
  });

  const revisionsQuery = useQuery({
    queryKey: (() => {
      if (!selectedCompanyId || !selectedTarget) return ["company-doc-revisions", "__disabled__"] as const;
      if (selectedTarget.kind === "company") {
        return queryKeys.companies.documentRevisions(selectedCompanyId, selectedTarget.key);
      }
      return queryKeys.companies.teamDocumentRevisions(
        selectedCompanyId,
        selectedTarget.departmentKey,
        selectedTarget.departmentName,
        selectedTarget.key,
      );
    })(),
    queryFn: () => {
      if (!selectedCompanyId || !selectedTarget) throw new Error("No document selected");
      if (selectedTarget.kind === "company") {
        return companiesApi.listDocumentRevisions(selectedCompanyId, selectedTarget.key);
      }
      return companiesApi.listTeamDocumentRevisions(
        selectedCompanyId,
        selectedTarget.departmentKey,
        selectedTarget.key,
        selectedTarget.departmentName,
      );
    },
    enabled: !!selectedCompanyId && !!selectedTarget,
  });

  const activeDocument = (selectedTarget?.kind === "company"
    ? companyDocumentQuery.data
    : teamDocumentQuery.data) as CompanyDocument | TeamDocument | undefined;

  useEffect(() => {
    if (!selectedTarget || !selectedCompany) return;
    if (activeDocument) {
      setDraftTitle(activeDocument.title ?? selectedTarget.label);
      setDraftBody(activeDocument.body);
      return;
    }
    if (selectedTarget.kind === "company") {
      setDraftTitle(selectedTarget.label);
      setDraftBody(buildCompanyTemplate(selectedCompany.name));
      return;
    }
    setDraftTitle(selectedTarget.label);
    setDraftBody(buildTeamTemplate(departmentLabel(selectedTarget.departmentKey, selectedTarget.departmentName)));
  }, [activeDocument, selectedCompany, selectedTarget]);

  const invalidateSelectedDoc = async (target: DocTarget) => {
    if (!selectedCompanyId) return;
    await queryClient.invalidateQueries({ queryKey: queryKeys.companies.documents(selectedCompanyId) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.companies.teamDocuments(selectedCompanyId) });
    if (target.kind === "company") {
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.document(selectedCompanyId, target.key) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.documentRevisions(selectedCompanyId, target.key) });
      return;
    }
    await queryClient.invalidateQueries({
      queryKey: queryKeys.companies.teamDocument(selectedCompanyId, target.departmentKey, target.departmentName, target.key),
    });
    await queryClient.invalidateQueries({
      queryKey: queryKeys.companies.teamDocumentRevisions(selectedCompanyId, target.departmentKey, target.departmentName, target.key),
    });
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!selectedCompanyId || !selectedTarget) throw new Error("No document selected");
      const payload = {
        title: draftTitle.trim() || selectedTarget.label,
        format: "markdown" as const,
        body: draftBody,
        baseRevisionId: activeDocument?.latestRevisionId ?? null,
      };
      if (selectedTarget.kind === "company") {
        return companiesApi.upsertDocument(selectedCompanyId, selectedTarget.key, payload);
      }
      return companiesApi.upsertTeamDocument(
        selectedCompanyId,
        selectedTarget.departmentKey,
        selectedTarget.key,
        payload,
        selectedTarget.departmentName,
      );
    },
    onSuccess: async () => {
      if (!selectedTarget) return;
      await invalidateSelectedDoc(selectedTarget);
      pushToast({ title: "Document saved", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to save document",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const restoreMutation = useMutation({
    mutationFn: async (revisionId: string) => {
      if (!selectedCompanyId || !selectedTarget) throw new Error("No document selected");
      if (selectedTarget.kind === "company") {
        return companiesApi.restoreDocumentRevision(selectedCompanyId, selectedTarget.key, revisionId);
      }
      return companiesApi.restoreTeamDocumentRevision(
        selectedCompanyId,
        selectedTarget.departmentKey,
        selectedTarget.key,
        revisionId,
        selectedTarget.departmentName,
      );
    },
    onSuccess: async () => {
      if (!selectedTarget) return;
      await invalidateSelectedDoc(selectedTarget);
      pushToast({ title: "Revision restored", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to restore revision",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  if (!selectedCompanyId || !selectedCompany) {
    return <div className="text-sm text-muted-foreground">Select a company to manage docs.</div>;
  }

  return (
    <div className="grid min-h-0 gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="space-y-3 rounded-lg border border-border p-4">
        <div className="flex items-center gap-2">
          <BookOpenText className="h-4 w-4 text-muted-foreground" />
          <h1 className="text-sm font-semibold">Durable docs</h1>
        </div>
        <div className="space-y-1">
          {documentTargets.map((target) => {
            const isSelected = target.id === selectedTarget?.id;
            return (
              <button
                key={target.id}
                type="button"
                onClick={() => {
                  setSelectedId(target.id);
                  navigate({ hash: target.hash }, { replace: true });
                }}
                className={`w-full rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                  isSelected
                    ? "border-foreground/30 bg-accent text-foreground"
                    : "border-border bg-background text-muted-foreground hover:text-foreground"
                }`}
              >
                <div className="font-medium">{target.label}</div>
                {target.kind === "team" ? (
                  <div className="mt-1 text-xs text-muted-foreground">
                    {departmentLabel(target.departmentKey, target.departmentName)}
                  </div>
                ) : null}
              </button>
            );
          })}
        </div>
      </aside>

      <section className="min-h-0 space-y-4 rounded-lg border border-border p-5">
        {selectedTarget ? (
          <div id={selectedTarget.hash.slice(1)} className="space-y-4">
            <div className="space-y-1">
              <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                {selectedTarget.kind === "company" ? "Company artifact" : "Department artifact"}
              </div>
              <h2 className="text-xl font-semibold">{selectedTarget.label}</h2>
              {selectedTarget.kind === "team" ? (
                <p className="text-sm text-muted-foreground">
                  Department: {departmentLabel(selectedTarget.departmentKey, selectedTarget.departmentName)}
                </p>
              ) : null}
            </div>

            <div className="grid gap-3 md:grid-cols-[220px_minmax(0,1fr)]">
              <div className="text-sm font-medium text-muted-foreground">Title</div>
              <Input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} />
              <div className="text-sm font-medium text-muted-foreground">Body</div>
              <Textarea
                value={draftBody}
                onChange={(event) => setDraftBody(event.target.value)}
                rows={24}
                className="min-h-[28rem] font-mono text-sm"
              />
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
                <Save className="h-4 w-4" />
                Save
              </Button>
              {activeDocument ? (
                <span className="text-xs text-muted-foreground">
                  Revision {activeDocument.latestRevisionNumber}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">New scaffold</span>
              )}
            </div>

            <div className="space-y-3 rounded-lg border border-border p-4">
              <div className="flex items-center gap-2">
                <History className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">Revision history</h3>
              </div>
              {revisionsQuery.isLoading ? (
                <div className="text-sm text-muted-foreground">Loading revisions...</div>
              ) : revisionsQuery.data && revisionsQuery.data.length > 0 ? (
                <div className="space-y-2">
                  {revisionsQuery.data.map((revision) => (
                    <div
                      key={revision.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium">
                          Revision {revision.revisionNumber}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {new Date(revision.createdAt).toLocaleString()}
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => restoreMutation.mutate(revision.id)}
                        disabled={restoreMutation.isPending || activeDocument?.latestRevisionId === revision.id}
                      >
                        Restore
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">No revisions yet.</div>
              )}
            </div>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">Select a document.</div>
        )}
      </section>
    </div>
  );
}

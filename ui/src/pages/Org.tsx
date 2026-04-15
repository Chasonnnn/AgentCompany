import { useEffect } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import type { AccountabilityProjectNode, AgentHierarchyMemberSummary, CompanyAgentAccountability } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { GitBranch } from "lucide-react";

function MemberList({
  label,
  members,
}: {
  label: string;
  members: AgentHierarchyMemberSummary[];
}) {
  if (members.length === 0) return null;
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{label}</h3>
      <div className="border border-border divide-y divide-border overflow-hidden">
        {members.map((member) => (
          <Link
            key={member.id}
            to={`/agents/${member.id}`}
            className="flex items-center gap-3 px-3 py-2 text-sm no-underline text-inherit transition-colors hover:bg-accent/50"
          >
            <span className="font-medium flex-1">{member.name}</span>
            <span className="text-xs text-muted-foreground">{member.title ?? member.role}</span>
            <StatusBadge status={member.status} />
          </Link>
        ))}
      </div>
    </section>
  );
}

function AccountabilityProject({
  project,
}: {
  project: AccountabilityProjectNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-foreground">{project.projectName}</h2>
        {project.issueCounts.blockedMissingDocs > 0 ? (
          <span className="text-xs text-amber-600 dark:text-amber-400">
            {project.issueCounts.blockedMissingDocs} missing docs
          </span>
        ) : null}
        {project.issueCounts.openReviewFindings > 0 ? (
          <span className="text-xs text-amber-600 dark:text-amber-400">
            {project.issueCounts.openReviewFindings} findings
          </span>
        ) : null}
        {project.issueCounts.returnedBranches > 0 ? (
          <span className="text-xs text-blue-600 dark:text-blue-400">
            {project.issueCounts.returnedBranches} returns
          </span>
        ) : null}
      </div>
      <MemberList label="Project Leadership" members={project.leadership} />
      <MemberList label="Continuity Owners" members={project.continuityOwners} />
      <MemberList label="Shared Services" members={project.sharedServices} />
    </section>
  );
}

function AccountabilityView({
  accountability,
}: {
  accountability: CompanyAgentAccountability;
}) {
  return (
    <div className="space-y-6">
      <MemberList label="Executive Office" members={accountability.executiveOffice} />
      {accountability.projects.map((project) => (
        <AccountabilityProject key={project.projectId ?? project.projectName} project={project} />
      ))}
      {accountability.sharedServices.map((group) => (
        <MemberList key={`${group.key}:${group.name}`} label={group.name} members={group.leaders} />
      ))}
      <MemberList label="Unassigned" members={accountability.unassigned} />
    </div>
  );
}

export function Org() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Org" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.agents.accountability(selectedCompanyId!),
    queryFn: () => agentsApi.accountability(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={GitBranch} message="Select a company to view accountability." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      {error ? <p className="text-sm text-destructive">{error.message}</p> : null}
      {data && data.projects.length === 0 && data.executiveOffice.length === 0 && data.unassigned.length === 0 ? (
        <EmptyState
          icon={GitBranch}
          message="No accountability graph yet. Create agents and assign issue ownership to build it."
        />
      ) : null}
      {data ? <AccountabilityView accountability={data} /> : null}
    </div>
  );
}

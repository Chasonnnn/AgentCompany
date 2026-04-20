import {
  AGENT_DEPARTMENT_LABELS,
  type Agent,
  type AgentHierarchyMemberSummary,
  type AgentNavigationClusterNode,
  type AgentNavigationDepartmentNode,
  type AgentNavigationProjectNode,
  type AgentNavigationTeamNode,
  type CompanyAgentAccountability,
  type CompanyAgentNavigation,
  type OperatingHierarchyDepartmentSummary,
} from "@paperclipai/shared";

export interface SharedSpecialistGroup<T extends AgentHierarchyMemberSummary = AgentHierarchyMemberSummary> {
  key: string;
  label: string;
  members: T[];
}

function departmentLabel(
  departmentKey: Agent["departmentKey"],
  departmentName: string | null,
) {
  if (departmentKey === "custom") return departmentName?.trim() || "Custom";
  return AGENT_DEPARTMENT_LABELS[departmentKey];
}

function isConsultant(member: Pick<AgentHierarchyMemberSummary, "operatingClass"> | null | undefined) {
  return member?.operatingClass === "consultant";
}

function isNonConsultant(member: Pick<AgentHierarchyMemberSummary, "operatingClass">) {
  return member.operatingClass !== "consultant";
}

function dedupeMembers<T extends AgentHierarchyMemberSummary>(members: T[]) {
  const deduped = new Map<string, T>();
  for (const member of members) {
    if (deduped.has(member.id)) continue;
    deduped.set(member.id, member);
  }
  return Array.from(deduped.values()).sort((left, right) => left.name.localeCompare(right.name));
}

function collectNavigationConsultantsFromTeam(team: AgentNavigationTeamNode) {
  return [
    ...team.leaders.filter(isConsultant),
    ...team.workers.filter(isConsultant),
  ];
}

function collectNavigationConsultantsFromProject(project: AgentNavigationProjectNode) {
  return [
    ...project.leaders.filter(isConsultant),
    ...project.workers.filter(isConsultant),
    ...project.teams.flatMap(collectNavigationConsultantsFromTeam),
  ];
}

function collectNavigationConsultantsFromCluster(cluster: AgentNavigationClusterNode) {
  return cluster.projects.flatMap(collectNavigationConsultantsFromProject);
}

function groupSharedSpecialists<T extends AgentHierarchyMemberSummary>(members: T[]): SharedSpecialistGroup<T>[] {
  const grouped = new Map<string, SharedSpecialistGroup<T>>();
  for (const member of dedupeMembers(members).filter(isConsultant)) {
    const key = `${member.departmentKey}:${member.departmentName ?? ""}`;
    const group = grouped.get(key) ?? {
      key,
      label: departmentLabel(member.departmentKey, member.departmentName),
      members: [],
    };
    group.members.push(member);
    grouped.set(key, group);
  }
  return Array.from(grouped.values()).sort((left, right) => left.label.localeCompare(right.label));
}

function filterSharedServiceTeam(team: AgentNavigationTeamNode): AgentNavigationTeamNode | null {
  const leaders = team.leaders.filter(isNonConsultant);
  const workers = team.workers.filter(isNonConsultant);
  if (leaders.length === 0 && workers.length === 0) return null;
  return { ...team, leaders, workers };
}

function filterSharedServiceProject(project: AgentNavigationProjectNode): AgentNavigationProjectNode | null {
  const leaders = project.leaders.filter(isNonConsultant);
  const teams = project.teams
    .map(filterSharedServiceTeam)
    .filter((team): team is AgentNavigationTeamNode => Boolean(team));
  const workers = project.workers.filter(isNonConsultant);
  if (leaders.length === 0 && teams.length === 0 && workers.length === 0) return null;
  return { ...project, leaders, teams, workers };
}

function filterSharedServiceCluster(cluster: AgentNavigationClusterNode): AgentNavigationClusterNode | null {
  const projects = cluster.projects
    .map(filterSharedServiceProject)
    .filter((project): project is AgentNavigationProjectNode => Boolean(project));
  if (projects.length === 0) return null;
  return { ...cluster, projects };
}

export function buildSharedSpecialistGroupsFromNavigation(
  navigation: CompanyAgentNavigation,
): SharedSpecialistGroup[] {
  const consultants = navigation.sharedServices.flatMap((department) => [
    ...department.leaders.filter(isConsultant),
    ...department.projects.flatMap(collectNavigationConsultantsFromProject),
    ...(department.clusters ?? []).flatMap(collectNavigationConsultantsFromCluster),
  ]);
  return groupSharedSpecialists(consultants);
}

export function buildSharedServiceLeadDepartmentsFromNavigation(
  navigation: CompanyAgentNavigation,
): AgentNavigationDepartmentNode[] {
  const departments: AgentNavigationDepartmentNode[] = [];
  for (const department of navigation.sharedServices) {
    const leaders = department.leaders.filter(isNonConsultant);
    const clusters = (department.clusters ?? [])
      .map(filterSharedServiceCluster)
      .filter((cluster): cluster is AgentNavigationClusterNode => Boolean(cluster));
    const projects = department.projects
      .map(filterSharedServiceProject)
      .filter((project): project is AgentNavigationProjectNode => Boolean(project));
    if (leaders.length === 0 && clusters.length === 0 && projects.length === 0) continue;
    departments.push({
      ...department,
      leaders,
      projects,
      ...(department.clusters ? { clusters } : {}),
    });
  }
  return departments;
}

export function buildSharedSpecialistGroupsFromAccountability(
  accountability: CompanyAgentAccountability,
): SharedSpecialistGroup[] {
  const consultants = [
    ...accountability.sharedServices.flatMap((department) => department.leaders.filter(isConsultant)),
    ...accountability.projects.flatMap((project) => project.sharedServices.filter(isConsultant)),
  ];
  return groupSharedSpecialists(consultants);
}

export function buildSharedServiceLeadDepartmentsFromAccountability(
  accountability: CompanyAgentAccountability,
): OperatingHierarchyDepartmentSummary[] {
  return accountability.sharedServices
    .map((department) => {
      const leaders = department.leaders.filter(isNonConsultant);
      if (leaders.length === 0 && department.projects.length === 0) return null;
      return { ...department, leaders };
    })
    .filter((department): department is OperatingHierarchyDepartmentSummary => Boolean(department));
}

export function countSharedSpecialists(groups: SharedSpecialistGroup[]) {
  return groups.reduce((sum, group) => sum + group.members.length, 0);
}

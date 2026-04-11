import type { CompanyOperatingHierarchy } from "@paperclipai/shared";

function clusterLeaderIds(hierarchy: CompanyOperatingHierarchy) {
  return (hierarchy.portfolioClusters ?? []).flatMap((cluster) => [
    ...(cluster.portfolioDirector ? [cluster.portfolioDirector.id] : []),
    ...cluster.projects.flatMap((project) => project.leadership.map((agent) => agent.id)),
  ]);
}

export function collectLeaderIds(hierarchy: CompanyOperatingHierarchy) {
  return Array.from(new Set([
    ...hierarchy.executiveOffice.map((agent) => agent.id),
    ...(hierarchy.portfolioClusters?.length
      ? clusterLeaderIds(hierarchy)
      : hierarchy.projectPods.flatMap((project) => project.leadership.map((agent) => agent.id))),
    ...hierarchy.sharedServices.flatMap((department) => department.leaders.map((agent) => agent.id)),
  ]));
}

export function collectExecutiveIds(hierarchy: CompanyOperatingHierarchy) {
  return Array.from(new Set(hierarchy.executiveOffice.map((agent) => agent.id)));
}

export function conferenceRoomLeadershipBulkGroups(hierarchy: CompanyOperatingHierarchy) {
  return [
    ...((hierarchy.portfolioClusters?.length ?? 0) > 0
      ? (hierarchy.portfolioClusters ?? [])
          .map((cluster) => ({
            key: `cluster:${cluster.clusterId}`,
            label: `${cluster.name} leadership`,
            agentIds: Array.from(new Set([
              ...(cluster.portfolioDirector ? [cluster.portfolioDirector.id] : []),
              ...cluster.projects.flatMap((project) => project.leadership.map((leader) => leader.id)),
            ])),
          }))
          .filter((group) => group.agentIds.length > 0)
      : hierarchy.projectPods
          .filter((project) => project.leadership.length > 0)
          .map((project) => ({
            key: `project:${project.projectId}`,
            label: `${project.projectName} leadership`,
            agentIds: Array.from(new Set(project.leadership.map((leader) => leader.id))),
          }))),
    ...hierarchy.sharedServices
      .filter((department) => department.leaders.length > 0)
      .map((department) => ({
        key: `shared:${department.key}:${department.name}`,
        label: `${department.name} leads`,
        agentIds: Array.from(new Set(department.leaders.map((leader) => leader.id))),
      })),
  ];
}

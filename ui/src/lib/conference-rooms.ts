import type { CompanyOperatingHierarchy } from "@paperclipai/shared";

export function collectLeaderIds(hierarchy: CompanyOperatingHierarchy) {
  return Array.from(new Set([
    ...hierarchy.executiveOffice.map((agent) => agent.id),
    ...hierarchy.projectPods.flatMap((project) => project.leadership.map((agent) => agent.id)),
    ...hierarchy.sharedServices.flatMap((department) => department.leaders.map((agent) => agent.id)),
  ]));
}

export function collectExecutiveIds(hierarchy: CompanyOperatingHierarchy) {
  return Array.from(new Set(hierarchy.executiveOffice.map((agent) => agent.id)));
}

export function conferenceRoomLeadershipBulkGroups(hierarchy: CompanyOperatingHierarchy) {
  return [
    ...hierarchy.projectPods
      .filter((project) => project.leadership.length > 0)
      .map((project) => ({
        key: `project:${project.projectId}`,
        label: `${project.projectName} leadership`,
        agentIds: Array.from(new Set(project.leadership.map((leader) => leader.id))),
      })),
    ...hierarchy.sharedServices
      .filter((department) => department.leaders.length > 0)
      .map((department) => ({
        key: `shared:${department.key}:${department.name}`,
        label: `${department.name} leads`,
        agentIds: Array.from(new Set(department.leaders.map((leader) => leader.id))),
      })),
  ];
}

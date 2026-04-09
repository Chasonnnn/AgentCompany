import type { CompanyAgentHierarchy } from "@paperclipai/shared";

export function collectLeaderIds(hierarchy: CompanyAgentHierarchy) {
  return Array.from(new Set([
    ...hierarchy.executives.map((group) => group.executive.id),
    ...hierarchy.executives.flatMap((group) => group.departments.flatMap((department) => department.directors.map((director) => director.id))),
    ...hierarchy.unassigned.executives.map((agent) => agent.id),
    ...hierarchy.unassigned.directors.map((agent) => agent.id),
  ]));
}

export function collectExecutiveIds(hierarchy: CompanyAgentHierarchy) {
  return Array.from(new Set([
    ...hierarchy.executives.map((group) => group.executive.id),
    ...hierarchy.unassigned.executives.map((agent) => agent.id),
  ]));
}

export function conferenceRoomLeadershipBulkGroups(hierarchy: CompanyAgentHierarchy) {
  return hierarchy.executives.flatMap((group) =>
    group.departments
      .filter((department) => department.directors.length > 0)
      .map((department) => ({
        key: `${group.executive.id}:${department.key}:${department.name}`,
        label: `${department.name} leadership`,
        agentIds: Array.from(new Set([group.executive.id, ...department.directors.map((director) => director.id)])),
      })),
  );
}

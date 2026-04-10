import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import {
  AGENT_DEPARTMENT_LABELS,
  type AgentNavigationDepartmentNode,
  type AgentNavigationProjectNode,
  type AgentSkillSnapshot,
  type BulkSkillGrantApplyRequest,
  type BulkSkillGrantMode,
  type BulkSkillGrantPreview,
  type BulkSkillGrantPreviewAgent,
  type BulkSkillGrantRequest,
  type BulkSkillGrantResult,
  type BulkSkillGrantTargetSummary,
  type OperatingHierarchyAgentSummary,
} from "@paperclipai/shared";
import {
  readPaperclipSkillSyncPreference,
  writePaperclipSkillSyncPreference,
  type PaperclipSkillEntry,
} from "@paperclipai/adapter-utils/server-utils";
import { conflict, notFound, unprocessable, HttpError } from "../errors.js";
import { findActiveServerAdapter } from "../adapters/index.js";
import { agentService, type NormalizedAgentRow } from "./agents.js";
import { companySkillService } from "./company-skills.js";
import { secretService } from "./secrets.js";
import { logActivity, type LogActivityInput } from "./activity-log.js";

const ADAPTERS_REQUIRING_MATERIALIZED_RUNTIME_SKILLS = new Set([
  "cursor",
  "gemini_local",
  "opencode_local",
  "pi_local",
]);

interface ActorInfo {
  actorType: LogActivityInput["actorType"];
  actorId: string;
  agentId: string | null;
  runId: string | null;
}

interface DesiredSkillAssignment {
  adapterConfig: Record<string, unknown>;
  desiredSkills: string[] | null;
  runtimeSkillEntries: PaperclipSkillEntry[] | null;
}

interface BulkSkillAgentPlan {
  agent: NormalizedAgentRow;
  currentDesiredSkills: string[];
  currentExplicitDesiredSkills: string[];
  nextDesiredSkills: string[];
  nextExplicitDesiredSkills: string[];
  nextAdapterConfig: Record<string, unknown>;
  change: BulkSkillGrantPreviewAgent["change"];
}

interface BulkSkillGrantPlan {
  preview: BulkSkillGrantPreview;
  agents: BulkSkillAgentPlan[];
}

function normalizeDesiredSkillReferences(requestedDesiredSkills: string[]) {
  return Array.from(new Set(requestedDesiredSkills.map((value) => value.trim()).filter(Boolean)));
}

function desiredSkillsChanged(left: string[], right: string[]) {
  if (left.length !== right.length) return true;
  return left.some((value, index) => value !== right[index]);
}

type NavigationMember = Pick<OperatingHierarchyAgentSummary, "id" | "name">;

function dedupeAgents<T extends { id: string }>(agents: T[]) {
  return Array.from(new Map(agents.map((agent) => [agent.id, agent])).values());
}

function collectProjectNodeMembers(projectNode: AgentNavigationProjectNode) {
  const leaders = dedupeAgents([
    ...projectNode.leaders,
    ...projectNode.teams.flatMap((team) => team.leaders),
  ]);
  const workers = dedupeAgents([
    ...projectNode.workers,
    ...projectNode.teams.flatMap((team) => team.workers),
  ]);
  return { leaders, workers };
}

function resolveTierMembers(
  leaders: NavigationMember[],
  workers: NavigationMember[],
  tier: BulkSkillGrantRequest["tier"],
) {
  if (tier === "leaders") return leaders;
  if (tier === "workers") return workers;
  return dedupeAgents([...leaders, ...workers]);
}

function previewAgentChange(
  currentExplicitDesiredSkills: string[],
  nextExplicitDesiredSkills: string[],
): BulkSkillGrantPreviewAgent["change"] {
  if (!desiredSkillsChanged(currentExplicitDesiredSkills, nextExplicitDesiredSkills)) {
    return "unchanged";
  }
  if (currentExplicitDesiredSkills.length === 0 && nextExplicitDesiredSkills.length > 0) {
    return "add";
  }
  if (currentExplicitDesiredSkills.length > 0 && nextExplicitDesiredSkills.length === 0) {
    return "remove";
  }
  if (
    nextExplicitDesiredSkills.every((skillKey) => currentExplicitDesiredSkills.includes(skillKey))
    && nextExplicitDesiredSkills.length > currentExplicitDesiredSkills.length
  ) {
    return "add";
  }
  if (
    currentExplicitDesiredSkills.every((skillKey) => nextExplicitDesiredSkills.includes(skillKey))
    && nextExplicitDesiredSkills.length < currentExplicitDesiredSkills.length
  ) {
    return "remove";
  }
  return "replace";
}

function applyBulkSkillMode(
  currentExplicitDesiredSkills: string[],
  skillKey: string,
  mode: BulkSkillGrantMode,
) {
  const current = new Set(currentExplicitDesiredSkills);
  if (mode === "add") {
    current.add(skillKey);
    return Array.from(current).sort();
  }
  if (mode === "remove") {
    current.delete(skillKey);
    return Array.from(current).sort();
  }
  return [skillKey];
}

function buildBulkSkillGrantFingerprint(
  preview: Omit<BulkSkillGrantPreview, "selectionFingerprint">,
  plans: BulkSkillAgentPlan[],
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        skillId: preview.skillId,
        target: preview.target,
        tier: preview.tier,
        mode: preview.mode,
        agents: plans.map((plan) => ({
          id: plan.agent.id,
          adapterType: plan.agent.adapterType,
          updatedAt: plan.agent.updatedAt.toISOString(),
          currentDesiredSkills: plan.currentDesiredSkills,
          nextDesiredSkills: plan.nextDesiredSkills,
        })),
      }),
    )
    .digest("hex");
}

export function agentSkillService(db: Db) {
  const agents = agentService(db);
  const companySkills = companySkillService(db);
  const secrets = secretService(db);

  function shouldMaterializeRuntimeSkillsForAdapter(adapterType: string) {
    return ADAPTERS_REQUIRING_MATERIALIZED_RUNTIME_SKILLS.has(adapterType);
  }

  function buildUnsupportedSkillSnapshot(
    adapterType: string,
    desiredSkills: string[],
    options?: { canManage?: boolean },
  ): AgentSkillSnapshot {
    return {
      adapterType,
      supported: false,
      mode: "unsupported",
      canManage: options?.canManage,
      desiredSkills,
      entries: [],
      warnings: ["This adapter does not implement skill sync yet."],
    };
  }

  async function buildRuntimeSkillConfig(
    companyId: string,
    adapterType: string,
    config: Record<string, unknown>,
  ) {
    const runtimeSkillEntries = await companySkills.listRuntimeSkillEntries(companyId, {
      materializeMissing: shouldMaterializeRuntimeSkillsForAdapter(adapterType),
    });
    return {
      ...config,
      paperclipRuntimeSkills: runtimeSkillEntries,
    };
  }

  async function resolveDesiredSkillAssignment(
    companyId: string,
    adapterType: string,
    adapterConfig: Record<string, unknown>,
    requestedDesiredSkills: string[] | undefined,
  ): Promise<DesiredSkillAssignment> {
    if (!requestedDesiredSkills) {
      return {
        adapterConfig,
        desiredSkills: null,
        runtimeSkillEntries: null,
      };
    }

    const resolvedRequestedSkills = await companySkills.resolveRequestedSkillKeys(
      companyId,
      requestedDesiredSkills,
    );
    const runtimeSkillEntries = await companySkills.listRuntimeSkillEntries(companyId, {
      materializeMissing: shouldMaterializeRuntimeSkillsForAdapter(adapterType),
    });
    const requiredSkills = runtimeSkillEntries
      .filter((entry) => entry.required)
      .map((entry) => entry.key);
    const desiredSkills = Array.from(new Set([...requiredSkills, ...resolvedRequestedSkills]));

    return {
      adapterConfig: writePaperclipSkillSyncPreference(adapterConfig, desiredSkills),
      desiredSkills,
      runtimeSkillEntries,
    };
  }

  async function listSkills(agent: NormalizedAgentRow, options?: { canManage?: boolean }) {
    const adapter = findActiveServerAdapter(agent.adapterType);
    const canManageSkills = options?.canManage ?? false;
    if (!adapter?.listSkills) {
      const preference = readPaperclipSkillSyncPreference(
        agent.adapterConfig as Record<string, unknown>,
      );
      const runtimeSkillEntries = await companySkills.listRuntimeSkillEntries(agent.companyId, {
        materializeMissing: false,
      });
      const requiredSkills = runtimeSkillEntries.filter((entry) => entry.required).map((entry) => entry.key);
      return buildUnsupportedSkillSnapshot(
        agent.adapterType,
        Array.from(new Set([...requiredSkills, ...preference.desiredSkills])),
        { canManage: canManageSkills },
      );
    }

    const { config: runtimeConfig } = await secrets.resolveAdapterConfigForRuntime(
      agent.companyId,
      agent.adapterConfig,
    );
    const runtimeSkillConfig = await buildRuntimeSkillConfig(
      agent.companyId,
      agent.adapterType,
      runtimeConfig,
    );
    const snapshot = await adapter.listSkills({
      agentId: agent.id,
      companyId: agent.companyId,
      adapterType: agent.adapterType,
      config: runtimeSkillConfig,
    });
    return {
      ...snapshot,
      canManage: canManageSkills,
    };
  }

  async function logSkillSyncActivity(
    agent: NormalizedAgentRow,
    desiredSkills: string[],
    snapshot: AgentSkillSnapshot,
    actor: ActorInfo,
    source: string,
  ) {
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "agent.skills_synced",
      entityType: "agent",
      entityId: agent.id,
      agentId: actor.agentId,
      runId: actor.runId,
      details: {
        adapterType: agent.adapterType,
        desiredSkills,
        mode: snapshot.mode,
        supported: snapshot.supported,
        entryCount: snapshot.entries.length,
        warningCount: snapshot.warnings.length,
        source,
      },
    });
  }

  async function syncRuntimeSkillsForAgent(
    agent: NormalizedAgentRow,
    desiredSkills: string[],
    actor: ActorInfo,
    options?: { source?: string; canManage?: boolean },
  ) {
    const adapter = findActiveServerAdapter(agent.adapterType);
    const { config: runtimeConfig } = await secrets.resolveAdapterConfigForRuntime(
      agent.companyId,
      agent.adapterConfig,
    );
    const runtimeSkillConfig = await buildRuntimeSkillConfig(
      agent.companyId,
      agent.adapterType,
      runtimeConfig,
    );
    const snapshot = adapter?.syncSkills
      ? await adapter.syncSkills(
          {
            agentId: agent.id,
            companyId: agent.companyId,
            adapterType: agent.adapterType,
            config: runtimeSkillConfig,
          },
          desiredSkills,
        )
      : adapter?.listSkills
        ? await adapter.listSkills({
            agentId: agent.id,
            companyId: agent.companyId,
            adapterType: agent.adapterType,
            config: runtimeSkillConfig,
          })
        : buildUnsupportedSkillSnapshot(agent.adapterType, desiredSkills, {
            canManage: options?.canManage ?? false,
          });

    await logSkillSyncActivity(
      agent,
      desiredSkills,
      snapshot,
      actor,
      options?.source ?? "skill-sync",
    );

    return {
      ...snapshot,
      canManage: options?.canManage ?? false,
    };
  }

  async function syncAgentSkills(
    agent: NormalizedAgentRow,
    requestedDesiredSkills: string[],
    actor: ActorInfo,
  ) {
    const normalizedRequestedSkills = normalizeDesiredSkillReferences(requestedDesiredSkills);
    const {
      adapterConfig: nextAdapterConfig,
      desiredSkills,
    } = await resolveDesiredSkillAssignment(
      agent.companyId,
      agent.adapterType,
      agent.adapterConfig as Record<string, unknown>,
      normalizedRequestedSkills,
    );
    if (!desiredSkills) {
      throw unprocessable("Skill sync requires desiredSkills.");
    }

    const updated = await agents.update(
      agent.id,
      { adapterConfig: nextAdapterConfig },
      {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "skill-sync",
        },
      },
    );
    if (!updated) {
      throw notFound("Agent not found");
    }

    return syncRuntimeSkillsForAgent(updated, desiredSkills, actor, {
      canManage: true,
      source: "skill-sync",
    });
  }

  async function resolveBulkSkillGrantPlan(
    companyId: string,
    skillId: string,
    input: BulkSkillGrantRequest,
  ): Promise<BulkSkillGrantPlan> {
    const [skill, navigation, runtimeSkillEntries, companyAgents] = await Promise.all([
      companySkills.getById(skillId),
      agents.navigationForCompany(companyId, "department"),
      companySkills.listRuntimeSkillEntries(companyId, { materializeMissing: false }),
      agents.list(companyId),
    ]);
    if (!skill || skill.companyId !== companyId) {
      throw notFound("Skill not found");
    }

    const requiredSkillKeys = new Set(
      runtimeSkillEntries.filter((entry) => entry.required).map((entry) => entry.key),
    );

    let targetSummary: BulkSkillGrantTargetSummary;
    let matchedAgentMembers: NavigationMember[] = [];

    if (input.target.kind === "department") {
      const departmentKey = input.target.departmentKey;
      if (departmentKey === "executive") {
        targetSummary = {
          kind: "department",
          departmentKey: "executive",
          label: AGENT_DEPARTMENT_LABELS.executive,
        };
        matchedAgentMembers = resolveTierMembers(navigation.executives, [], input.tier);
      } else {
        const department = navigation.departments.find(
          (entry) => entry.key === departmentKey,
        ) ?? null;
        targetSummary = {
          kind: "department",
          departmentKey,
          label: department?.name ?? AGENT_DEPARTMENT_LABELS[departmentKey] ?? departmentKey,
        };
        if (department) {
          const projectMembers = department.projects.map((project) => collectProjectNodeMembers(project));
          const leaders = dedupeAgents([
            ...department.leaders,
            ...projectMembers.flatMap((entry) => entry.leaders),
          ]);
          const workers = dedupeAgents(projectMembers.flatMap((entry) => entry.workers));
          matchedAgentMembers = resolveTierMembers(leaders, workers, input.tier);
        }
      }
    } else {
      const matchingProjectNodes = dedupeProjectNodes(
        [...navigation.departments, ...navigation.sharedServices],
        input.target.projectId,
      );
      const firstProject = matchingProjectNodes[0] ?? null;
      targetSummary = {
        kind: "project",
        projectId: input.target.projectId,
        label: firstProject?.projectName ?? "Unknown project",
      };
      if (matchingProjectNodes.length > 0) {
        const projectMembers = matchingProjectNodes.map((project) => collectProjectNodeMembers(project));
        const leaders = dedupeAgents(projectMembers.flatMap((project) => project.leaders));
        const workers = dedupeAgents(projectMembers.flatMap((project) => project.workers));
        matchedAgentMembers = resolveTierMembers(leaders, workers, input.tier);
      }
    }

    const matchedAgentIds = dedupeAgents(matchedAgentMembers).map((agent) => agent.id);
    const matchedAgentMembersById = new Map(matchedAgentMembers.map((agent) => [agent.id, agent] as const));
    const companyAgentsById = new Map(companyAgents.map((agent) => [agent.id, agent] as const));
    const eligibleAgents = matchedAgentIds
      .map((agentId) => companyAgentsById.get(agentId))
      .filter((agent): agent is NormalizedAgentRow => Boolean(agent));
    const skippedAgents = matchedAgentIds
      .filter((agentId) => !companyAgentsById.has(agentId))
      .map((agentId) => ({
        id: agentId,
        name: matchedAgentMembersById.get(agentId)?.name ?? agentId,
        reason: "Agent is no longer eligible for bulk skill grants.",
      }));

    const plans = eligibleAgents.map((agent) => {
      const currentDesiredSkills = readPaperclipSkillSyncPreference(
        agent.adapterConfig as Record<string, unknown>,
      ).desiredSkills;
      const currentExplicitDesiredSkills = currentDesiredSkills.filter((key) => !requiredSkillKeys.has(key));
      const nextExplicitDesiredSkills = applyBulkSkillMode(
        currentExplicitDesiredSkills,
        skill.key,
        input.mode,
      );
      const nextDesiredSkills = Array.from(new Set([
        ...runtimeSkillEntries.filter((entry) => entry.required).map((entry) => entry.key),
        ...nextExplicitDesiredSkills,
      ]));
      return {
        agent,
        currentDesiredSkills,
        currentExplicitDesiredSkills,
        nextDesiredSkills,
        nextExplicitDesiredSkills,
        nextAdapterConfig: writePaperclipSkillSyncPreference(
          agent.adapterConfig as Record<string, unknown>,
          nextDesiredSkills,
        ),
        change: previewAgentChange(currentExplicitDesiredSkills, nextExplicitDesiredSkills),
      } satisfies BulkSkillAgentPlan;
    });

    const previewWithoutFingerprint: Omit<BulkSkillGrantPreview, "selectionFingerprint"> = {
      skillId: skill.id,
      skillKey: skill.key,
      skillName: skill.name,
      target: targetSummary,
      tier: input.tier,
      mode: input.mode,
      matchedAgentCount: plans.length,
      changedAgentCount: plans.filter((plan) => plan.change !== "unchanged").length,
      addCount: plans.filter((plan) => plan.change === "add").length,
      removeCount: plans.filter((plan) => plan.change === "remove").length,
      unchangedCount: plans.filter((plan) => plan.change === "unchanged").length,
      agents: plans.map((plan) => ({
        id: plan.agent.id,
        name: plan.agent.name,
        urlKey: plan.agent.urlKey,
        role: plan.agent.role,
        title: plan.agent.title ?? null,
        currentDesiredSkills: plan.currentExplicitDesiredSkills,
        nextDesiredSkills: plan.nextExplicitDesiredSkills,
        change: plan.change,
      })),
      skippedAgents,
    };

    const selectionFingerprint = buildBulkSkillGrantFingerprint(previewWithoutFingerprint, plans);

    return {
      preview: {
        ...previewWithoutFingerprint,
        selectionFingerprint,
      },
      agents: plans,
    };
  }

  async function previewBulkSkillGrant(
    companyId: string,
    skillId: string,
    input: BulkSkillGrantRequest,
  ) {
    return (await resolveBulkSkillGrantPlan(companyId, skillId, input)).preview;
  }

  async function applyBulkSkillGrant(
    companyId: string,
    skillId: string,
    input: BulkSkillGrantApplyRequest,
    actor: ActorInfo,
  ): Promise<BulkSkillGrantResult> {
    const plan = await resolveBulkSkillGrantPlan(companyId, skillId, input);
    if (plan.preview.selectionFingerprint !== input.selectionFingerprint) {
      throw conflict("Bulk skill grant preview is stale. Refresh the preview and try again.");
    }

    const changedPlans = plan.agents.filter((entry) => entry.change !== "unchanged");
    if (changedPlans.length === 0) {
      return {
        skillId: plan.preview.skillId,
        skillKey: plan.preview.skillKey,
        skillName: plan.preview.skillName,
        target: plan.preview.target,
        tier: plan.preview.tier,
        mode: plan.preview.mode,
        matchedAgentCount: plan.preview.matchedAgentCount,
        changedAgentCount: 0,
        addCount: plan.preview.addCount,
        removeCount: plan.preview.removeCount,
        unchangedCount: plan.preview.unchangedCount,
        appliedAgentIds: [],
        rollbackPerformed: false,
        rollbackErrors: [],
      };
    }

    const originalConfigs = changedPlans.map((entry) => ({
      id: entry.agent.id,
      adapterConfig: entry.agent.adapterConfig as Record<string, unknown>,
      desiredSkills: entry.currentDesiredSkills,
    }));

    const updatedAgents = await agents.batchUpdateAdapterConfigs(
      changedPlans.map((entry) => ({
        id: entry.agent.id,
        adapterConfig: entry.nextAdapterConfig,
      })),
      {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "skill-bulk-sync",
        },
      },
    );
    const updatedById = new Map(updatedAgents.map((agent) => [agent.id, agent] as const));

    const syncedAgentIds: string[] = [];
    try {
      for (const entry of changedPlans) {
        const updated = updatedById.get(entry.agent.id);
        if (!updated) {
          throw notFound("Agent not found");
        }
        await syncRuntimeSkillsForAgent(updated, entry.nextDesiredSkills, actor, {
          canManage: true,
          source: "skill-bulk-sync",
        });
        syncedAgentIds.push(updated.id);
      }
    } catch (error) {
      const rollbackErrors: string[] = [];
      let rolledBackAgents: NormalizedAgentRow[] = [];
      try {
        rolledBackAgents = await agents.batchUpdateAdapterConfigs(
          originalConfigs.map((entry) => ({
            id: entry.id,
            adapterConfig: entry.adapterConfig,
          })),
          {
            recordRevision: {
              createdByAgentId: actor.agentId,
              createdByUserId: actor.actorType === "user" ? actor.actorId : null,
              source: "skill-bulk-rollback",
            },
          },
        );
      } catch (rollbackPersistError) {
        rollbackErrors.push(
          rollbackPersistError instanceof Error
            ? rollbackPersistError.message
            : "Failed to restore agent skill grants in storage.",
        );
      }

      if (rolledBackAgents.length > 0) {
        const rolledBackById = new Map(rolledBackAgents.map((agent) => [agent.id, agent] as const));
        for (const entry of originalConfigs) {
          const rolledBack = rolledBackById.get(entry.id);
          if (!rolledBack) continue;
          try {
            await syncRuntimeSkillsForAgent(rolledBack, entry.desiredSkills, actor, {
              canManage: true,
              source: "skill-bulk-rollback",
            });
          } catch (rollbackSyncError) {
            rollbackErrors.push(
              rollbackSyncError instanceof Error
                ? rollbackSyncError.message
                : `Failed to restore runtime skills for agent ${entry.id}.`,
            );
          }
        }
      }

      throw new HttpError(
        500,
        rollbackErrors.length > 0
          ? "Bulk skill grant failed and rollback could not be completed cleanly."
          : "Bulk skill grant failed. All agent skill changes were rolled back.",
        {
          rollbackPerformed: true,
          rollbackErrors,
          syncedAgentIds,
          cause: error instanceof Error ? error.message : "Bulk skill grant failed.",
        },
      );
    }

    return {
      skillId: plan.preview.skillId,
      skillKey: plan.preview.skillKey,
      skillName: plan.preview.skillName,
      target: plan.preview.target,
      tier: plan.preview.tier,
      mode: plan.preview.mode,
      matchedAgentCount: plan.preview.matchedAgentCount,
      changedAgentCount: plan.preview.changedAgentCount,
      addCount: plan.preview.addCount,
      removeCount: plan.preview.removeCount,
      unchangedCount: plan.preview.unchangedCount,
      appliedAgentIds: changedPlans.map((entry) => entry.agent.id),
      rollbackPerformed: false,
      rollbackErrors: [],
    };
  }

  return {
    shouldMaterializeRuntimeSkillsForAdapter,
    buildUnsupportedSkillSnapshot,
    buildRuntimeSkillConfig,
    resolveDesiredSkillAssignment,
    listSkills,
    syncAgentSkills,
    previewBulkSkillGrant,
    applyBulkSkillGrant,
  };
}

function dedupeProjectNodes(
  departments: AgentNavigationDepartmentNode[],
  projectId: string,
) {
  const out = new Map<string, AgentNavigationProjectNode>();
  for (const department of departments) {
    for (const project of department.projects) {
      if (project.projectId === projectId) {
        out.set(`${department.key}:${project.projectId}`, project);
      }
    }
  }
  return Array.from(out.values());
}

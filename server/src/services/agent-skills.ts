import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import {
  AGENT_DEPARTMENT_LABELS,
  getDefaultDesiredSkillSlugsForAgent,
  normalizeAgentUrlKey,
  type AgentNavigationDepartmentNode,
  type CompanySkill,
  type CompanySkillCoverageAudit,
  type CompanySkillCoverageAuditAgent,
  type CompanySkillCoveragePlannedImport,
  type CompanySkillCoverageRepairApplyRequest,
  type CompanySkillCoverageRepairPreview,
  type CompanySkillCoverageRepairResult,
  type CompanySkillCoverageResolvedSkill,
  type CompanySkillCoverageStatus,
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
import { companySkillService, readLocalSkillImportFromDirectory } from "./company-skills.js";
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

interface SkillCoverageAgentPlan {
  agent: NormalizedAgentRow;
  status: CompanySkillCoverageStatus;
  repairable: boolean;
  expectedSkillSlugs: string[];
  resolvedExpectedSkills: CompanySkillCoverageResolvedSkill[];
  requiredSkillKeys: string[];
  currentDesiredSkills: string[];
  currentFullDesiredSkills: string[];
  nextDesiredSkills: string[];
  nextFullDesiredSkills: string[];
  preservedCustomSkillKeys: string[];
  missingSkillSlugs: string[];
  ambiguousSkillSlugs: string[];
  unresolvedCurrentReferences: string[];
  note: string | null;
  nextAdapterConfig: Record<string, unknown>;
}

interface SkillCoveragePlan {
  audit: CompanySkillCoverageAudit;
  preview: CompanySkillCoverageRepairPreview;
  agents: SkillCoverageAgentPlan[];
  plannedImports: CompanySkillCoveragePlannedImport[];
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

const COVERAGE_SOURCE_ROOT_PRIORITY: Record<string, number> = {
  codex: 0,
  agents: 1,
  claude: 2,
};

function sortUniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

function arraysEqual(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function inferSkillSourceRoot(skill: Pick<CompanySkill, "sourceLocator" | "metadata">) {
  const metadata = typeof skill.metadata === "object" && skill.metadata && !Array.isArray(skill.metadata)
    ? skill.metadata as Record<string, unknown>
    : null;
  const metadataRoot = typeof metadata?.catalogSourceRoot === "string" ? metadata.catalogSourceRoot : null;
  if (metadataRoot === "codex" || metadataRoot === "agents" || metadataRoot === "claude") {
    return metadataRoot;
  }

  const locator = typeof skill.sourceLocator === "string" ? skill.sourceLocator : null;
  if (!locator) return null;
  const resolved = path.resolve(locator);
  const homeDir = path.resolve(process.env.HOME?.trim() || os.homedir());
  const roots = [
    { prefix: path.join(homeDir, ".codex", "skills"), root: "codex" },
    { prefix: path.join(homeDir, ".agents", "skills"), root: "agents" },
    { prefix: path.join(homeDir, ".claude", "skills"), root: "claude" },
  ] as const;
  for (const entry of roots) {
    const normalizedPrefix = `${entry.prefix}${path.sep}`;
    if (resolved === entry.prefix || resolved.startsWith(normalizedPrefix)) {
      return entry.root;
    }
  }
  return null;
}

function canonicalGstackSkillSource(slug: string) {
  const homeDir = path.resolve(process.env.HOME?.trim() || os.homedir());
  return path.join(homeDir, "gstack", ".agents", "skills", `gstack-${slug}`);
}

function buildSkillCoverageFingerprint(
  preview: Omit<CompanySkillCoverageRepairPreview, "selectionFingerprint">,
  plans: SkillCoverageAgentPlan[],
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        companyId: preview.companyId,
        plannedImports: preview.plannedImports,
        agents: plans
          .filter((plan) => plan.repairable && !arraysEqual(plan.currentDesiredSkills, plan.nextDesiredSkills))
          .map((plan) => ({
            id: plan.agent.id,
            updatedAt: plan.agent.updatedAt.toISOString(),
            status: plan.status,
            repairable: plan.repairable,
            currentDesiredSkills: plan.currentDesiredSkills,
            nextDesiredSkills: plan.nextDesiredSkills,
            requiredSkillKeys: plan.requiredSkillKeys,
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

  async function resolveCoverageImportCandidate(
    companyId: string,
    slug: string,
    cache: Map<string, Promise<CompanySkillCoveragePlannedImport | null>>,
  ) {
    const normalizedSlug = normalizeAgentUrlKey(slug) ?? slug;
    const existing = cache.get(normalizedSlug);
    if (existing) return existing;
    const pending = readLocalSkillImportFromDirectory(
      companyId,
      canonicalGstackSkillSource(normalizedSlug),
    )
      .then((imported) => {
        if (imported.slug !== normalizedSlug) return null;
        return {
          slug: normalizedSlug,
          name: imported.name,
          sourcePath: imported.sourceLocator ?? canonicalGstackSkillSource(normalizedSlug),
          expectedKey: imported.key,
        } satisfies CompanySkillCoveragePlannedImport;
      })
      .catch(() => null);
    cache.set(normalizedSlug, pending);
    return pending;
  }

  function choosePreferredSkill(
    candidates: CompanySkill[],
    currentDesiredSkills: string[],
  ): { skill: CompanySkill | null; ambiguous: boolean } {
    if (candidates.length === 0) {
      return { skill: null, ambiguous: false };
    }

    const currentMatches = candidates.filter((candidate) => currentDesiredSkills.includes(candidate.key));
    if (currentMatches.length === 1) {
      return { skill: currentMatches[0] ?? null, ambiguous: false };
    }
    if (currentMatches.length > 1) {
      return { skill: null, ambiguous: true };
    }

    if (candidates.length === 1) {
      return { skill: candidates[0] ?? null, ambiguous: false };
    }

    const sorted = [...candidates].sort((left, right) => {
      const leftPriority = COVERAGE_SOURCE_ROOT_PRIORITY[inferSkillSourceRoot(left) ?? ""] ?? 99;
      const rightPriority = COVERAGE_SOURCE_ROOT_PRIORITY[inferSkillSourceRoot(right) ?? ""] ?? 99;
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;
      return left.key.localeCompare(right.key);
    });
    const best = sorted[0] ?? null;
    const second = sorted[1] ?? null;
    if (!best) {
      return { skill: null, ambiguous: false };
    }
    const bestPriority = COVERAGE_SOURCE_ROOT_PRIORITY[inferSkillSourceRoot(best) ?? ""] ?? 99;
    const secondPriority = second ? COVERAGE_SOURCE_ROOT_PRIORITY[inferSkillSourceRoot(second) ?? ""] ?? 99 : null;
    if (secondPriority === null || secondPriority > bestPriority) {
      return { skill: best, ambiguous: false };
    }
    return { skill: null, ambiguous: true };
  }

  function resolveReferenceToSkillKey(
    reference: string,
    installedByKey: Map<string, CompanySkill>,
    installedBySlug: Map<string, CompanySkill[]>,
  ) {
    const trimmed = reference.trim();
    if (!trimmed) {
      return { key: null, ambiguous: false };
    }

    const byKey = installedByKey.get(trimmed) ?? null;
    if (byKey) {
      return { key: byKey.key, ambiguous: false };
    }

    const normalized = normalizeAgentUrlKey(trimmed);
    const candidateSlugs = new Set<string>();
    if (normalized) {
      candidateSlugs.add(normalized);
      const segments = normalized.split("/").filter(Boolean);
      const lastSegment = segments[segments.length - 1];
      if (lastSegment) {
        candidateSlugs.add(lastSegment);
      }
    }

    for (const slug of candidateSlugs) {
      const preferred = choosePreferredSkill(installedBySlug.get(slug) ?? [], []);
      if (preferred.skill) {
        return { key: preferred.skill.key, ambiguous: false };
      }
      if (preferred.ambiguous) {
        return { key: null, ambiguous: true };
      }
    }

    return { key: null, ambiguous: false };
  }

  async function resolveCoveragePlan(companyId: string): Promise<SkillCoveragePlan> {
    const [companyAgents, installedSkills, runtimeSkillEntries] = await Promise.all([
      agents.list(companyId),
      companySkills.listFull(companyId),
      companySkills.listRuntimeSkillEntries(companyId, { materializeMissing: false }),
    ]);

    const activeAgents = companyAgents.filter((agent) => agent.status !== "terminated");
    const requiredSkillKeys = sortUniqueStrings(
      runtimeSkillEntries.filter((entry) => entry.required).map((entry) => entry.key),
    );
    const requiredSkillKeySet = new Set(requiredSkillKeys);
    const installedByKey = new Map(installedSkills.map((skill) => [skill.key, skill] as const));
    const installedBySlug = new Map<string, CompanySkill[]>();
    for (const skill of installedSkills) {
      const slug = normalizeAgentUrlKey(skill.slug) ?? skill.slug;
      const existing = installedBySlug.get(slug) ?? [];
      existing.push(skill);
      installedBySlug.set(slug, existing);
    }

    const requiredSkillBySlug = new Map<string, CompanySkill>();
    for (const requiredKey of requiredSkillKeys) {
      const skill = installedByKey.get(requiredKey);
      if (!skill) continue;
      const slug = normalizeAgentUrlKey(skill.slug) ?? skill.slug;
      requiredSkillBySlug.set(slug, skill);
    }

    const importCandidateCache = new Map<string, Promise<CompanySkillCoveragePlannedImport | null>>();
    const auditAgents: CompanySkillCoverageAuditAgent[] = [];
    const plans: SkillCoverageAgentPlan[] = [];
    const plannedImportsByKey = new Map<string, CompanySkillCoveragePlannedImport>();

    for (const agent of activeAgents) {
      const rawDesiredSkills = readPaperclipSkillSyncPreference(
        agent.adapterConfig as Record<string, unknown>,
      ).desiredSkills;
      const resolvedCurrentDesired = new Set<string>();
      const unresolvedCurrentReferences = new Set<string>();
      const ambiguousCurrentReferences = new Set<string>();
      for (const reference of rawDesiredSkills) {
        const resolved = resolveReferenceToSkillKey(reference, installedByKey, installedBySlug);
        if (resolved.key) {
          resolvedCurrentDesired.add(resolved.key);
          continue;
        }
        if (resolved.ambiguous) {
          ambiguousCurrentReferences.add(reference);
        } else {
          unresolvedCurrentReferences.add(reference);
        }
      }

      const currentFullDesiredSkills = sortUniqueStrings([
        ...requiredSkillKeys,
        ...Array.from(resolvedCurrentDesired),
      ]);
      const currentDesiredSkills = currentFullDesiredSkills.filter((key) => !requiredSkillKeySet.has(key));

      const expectedSkillSlugs = getDefaultDesiredSkillSlugsForAgent({
        role: agent.role,
        operatingClass: agent.operatingClass,
        archetypeKey: agent.archetypeKey,
      });
      const resolvedExpectedSkills: CompanySkillCoverageResolvedSkill[] = [];
      const missingSkillSlugs = new Set<string>();
      const ambiguousSkillSlugs = new Set<string>();
      const unrepairableMissingSkillSlugs = new Set<string>();
      const expectedNonRequiredKeys = new Set<string>();

      for (const expectedSlug of expectedSkillSlugs) {
        const normalizedSlug = normalizeAgentUrlKey(expectedSlug) ?? expectedSlug;
        const requiredSkill = requiredSkillBySlug.get(normalizedSlug) ?? null;
        if (requiredSkill) {
          resolvedExpectedSkills.push({
            slug: normalizedSlug,
            key: requiredSkill.key,
            name: requiredSkill.name,
            source: "installed",
          });
          continue;
        }

        const preferredInstalled = choosePreferredSkill(
          installedBySlug.get(normalizedSlug) ?? [],
          currentFullDesiredSkills,
        );
        if (preferredInstalled.skill) {
          resolvedExpectedSkills.push({
            slug: normalizedSlug,
            key: preferredInstalled.skill.key,
            name: preferredInstalled.skill.name,
            source: "installed",
          });
          expectedNonRequiredKeys.add(preferredInstalled.skill.key);
          if (!currentFullDesiredSkills.includes(preferredInstalled.skill.key)) {
            missingSkillSlugs.add(normalizedSlug);
          }
          continue;
        }
        if (preferredInstalled.ambiguous) {
          ambiguousSkillSlugs.add(normalizedSlug);
          unrepairableMissingSkillSlugs.add(normalizedSlug);
          resolvedExpectedSkills.push({
            slug: normalizedSlug,
            key: null,
            name: null,
            source: "missing",
          });
          missingSkillSlugs.add(normalizedSlug);
          continue;
        }

        const importCandidate = await resolveCoverageImportCandidate(
          companyId,
          normalizedSlug,
          importCandidateCache,
        );
        if (importCandidate) {
          plannedImportsByKey.set(importCandidate.expectedKey, importCandidate);
          resolvedExpectedSkills.push({
            slug: normalizedSlug,
            key: importCandidate.expectedKey,
            name: importCandidate.name,
            source: "planned_import",
          });
          expectedNonRequiredKeys.add(importCandidate.expectedKey);
          missingSkillSlugs.add(normalizedSlug);
          continue;
        }

        resolvedExpectedSkills.push({
          slug: normalizedSlug,
          key: null,
          name: null,
          source: "missing",
        });
        missingSkillSlugs.add(normalizedSlug);
        unrepairableMissingSkillSlugs.add(normalizedSlug);
      }

      const nextDesiredSkills = sortUniqueStrings([
        ...currentDesiredSkills,
        ...Array.from(expectedNonRequiredKeys),
      ]);
      const nextFullDesiredSkills = sortUniqueStrings([...requiredSkillKeys, ...nextDesiredSkills]);
      const preservedCustomSkillKeys = currentDesiredSkills.filter(
        (key) => !Array.from(expectedNonRequiredKeys).includes(key),
      );

      let note: string | null = null;
      if (unresolvedCurrentReferences.size > 0) {
        note = `Unresolved desired skill refs: ${Array.from(unresolvedCurrentReferences).sort().join(", ")}`;
      } else if (ambiguousCurrentReferences.size > 0 || ambiguousSkillSlugs.size > 0) {
        note = `Ambiguous skill lineage for ${sortUniqueStrings([
          ...Array.from(ambiguousCurrentReferences),
          ...Array.from(ambiguousSkillSlugs),
        ]).join(", ")}`;
      } else if (preservedCustomSkillKeys.length > 0) {
        note = `Preserves ${preservedCustomSkillKeys.length} custom granted skill${preservedCustomSkillKeys.length === 1 ? "" : "s"}.`;
      } else if (missingSkillSlugs.size > 0) {
        note = `Repairs ${missingSkillSlugs.size} missing default skill${missingSkillSlugs.size === 1 ? "" : "s"}.`;
      }

      const needsChange = !arraysEqual(currentDesiredSkills, nextDesiredSkills);
      const hasNonrepairableGap =
        unrepairableMissingSkillSlugs.size > 0
        || unresolvedCurrentReferences.size > 0
        || ambiguousCurrentReferences.size > 0
        || ambiguousSkillSlugs.size > 0;
      const hasCustomizations = preservedCustomSkillKeys.length > 0;
      const repairable = !hasNonrepairableGap && needsChange;
      const status: CompanySkillCoverageStatus = hasNonrepairableGap
        ? "nonrepairable_gap"
        : hasCustomizations
          ? "customized"
          : needsChange
            ? "repairable_gap"
            : "covered";

      const nextAdapterConfig = writePaperclipSkillSyncPreference(
        agent.adapterConfig as Record<string, unknown>,
        nextFullDesiredSkills,
      );

      const auditAgent: CompanySkillCoverageAuditAgent = {
        id: agent.id,
        name: agent.name,
        urlKey: agent.urlKey,
        role: agent.role,
        title: agent.title ?? null,
        operatingClass: agent.operatingClass,
        archetypeKey: agent.archetypeKey,
        status,
        repairable,
        expectedSkillSlugs,
        resolvedExpectedSkills,
        requiredSkillKeys,
        currentDesiredSkills,
        nextDesiredSkills,
        missingSkillSlugs: sortUniqueStrings(Array.from(missingSkillSlugs)),
        ambiguousSkillSlugs: sortUniqueStrings([
          ...Array.from(ambiguousCurrentReferences),
          ...Array.from(ambiguousSkillSlugs),
        ]),
        preservedCustomSkillKeys,
        note,
      };
      auditAgents.push(auditAgent);
      plans.push({
        agent,
        status,
        repairable,
        expectedSkillSlugs,
        resolvedExpectedSkills,
        requiredSkillKeys,
        currentDesiredSkills,
        currentFullDesiredSkills,
        nextDesiredSkills,
        nextFullDesiredSkills,
        preservedCustomSkillKeys,
        missingSkillSlugs: auditAgent.missingSkillSlugs,
        ambiguousSkillSlugs: auditAgent.ambiguousSkillSlugs,
        unresolvedCurrentReferences: sortUniqueStrings(Array.from(unresolvedCurrentReferences)),
        note,
        nextAdapterConfig,
      });
    }

    auditAgents.sort((left, right) => left.name.localeCompare(right.name));
    plans.sort((left, right) => left.agent.name.localeCompare(right.agent.name));

    const plannedImports = Array.from(plannedImportsByKey.values()).sort((left, right) =>
      left.slug.localeCompare(right.slug),
    );
    const audit: CompanySkillCoverageAudit = {
      companyId,
      auditedAgentCount: auditAgents.length,
      coveredCount: auditAgents.filter((agent) => agent.status === "covered").length,
      repairableGapCount: auditAgents.filter((agent) => agent.status === "repairable_gap").length,
      nonrepairableGapCount: auditAgents.filter((agent) => agent.status === "nonrepairable_gap").length,
      customizedCount: auditAgents.filter((agent) => agent.status === "customized").length,
      plannedImports,
      agents: auditAgents,
    };
    const previewWithoutFingerprint: Omit<CompanySkillCoverageRepairPreview, "selectionFingerprint"> = {
      ...audit,
      changedAgentCount: plans.filter(
        (plan) => plan.repairable && !arraysEqual(plan.currentDesiredSkills, plan.nextDesiredSkills),
      ).length,
    };
    const selectionFingerprint = buildSkillCoverageFingerprint(previewWithoutFingerprint, plans);

    return {
      audit,
      preview: {
        ...previewWithoutFingerprint,
        selectionFingerprint,
      },
      agents: plans,
      plannedImports,
    };
  }

  async function coverageAudit(companyId: string) {
    return (await resolveCoveragePlan(companyId)).audit;
  }

  async function previewCoverageRepair(companyId: string) {
    return (await resolveCoveragePlan(companyId)).preview;
  }

  async function applyCoverageRepair(
    companyId: string,
    input: CompanySkillCoverageRepairApplyRequest,
    actor: ActorInfo,
  ): Promise<CompanySkillCoverageRepairResult> {
    const plan = await resolveCoveragePlan(companyId);
    if (plan.preview.selectionFingerprint !== input.selectionFingerprint) {
      throw conflict("Skill coverage preview is stale. Refresh the preview and try again.");
    }

    const changedPlans = plan.agents.filter(
      (entry) => entry.repairable && !arraysEqual(entry.currentDesiredSkills, entry.nextDesiredSkills),
    );
    if (changedPlans.length === 0 && plan.plannedImports.length === 0) {
      return {
        companyId,
        changedAgentCount: 0,
        appliedAgentIds: [],
        importedSkills: [],
        rollbackPerformed: false,
        rollbackErrors: [],
        selectionFingerprint: plan.preview.selectionFingerprint,
        audit: plan.audit,
      };
    }

    const importedSkills: CompanySkill[] = [];
    for (const plannedImport of plan.plannedImports) {
      const result = await companySkills.importFromSource(companyId, plannedImport.sourcePath);
      const imported = result.imported.find((skill) => skill.key === plannedImport.expectedKey)
        ?? result.imported[0]
        ?? null;
      if (!imported) {
        throw conflict(`Failed to import ${plannedImport.slug} from ${plannedImport.sourcePath}.`);
      }
      importedSkills.push(imported);
    }

    const originalConfigs = changedPlans.map((entry) => ({
      id: entry.agent.id,
      adapterConfig: entry.agent.adapterConfig as Record<string, unknown>,
      desiredSkills: entry.currentFullDesiredSkills,
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
          source: "skill-coverage-repair",
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
        await syncRuntimeSkillsForAgent(updated, entry.nextFullDesiredSkills, actor, {
          canManage: true,
          source: "skill-coverage-repair",
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
              source: "skill-coverage-repair-rollback",
            },
          },
        );
      } catch (rollbackPersistError) {
        rollbackErrors.push(
          rollbackPersistError instanceof Error
            ? rollbackPersistError.message
            : "Failed to restore agent skill coverage settings in storage.",
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
              source: "skill-coverage-repair-rollback",
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
          ? "Skill coverage repair failed and rollback could not be completed cleanly."
          : "Skill coverage repair failed. All agent skill changes were rolled back.",
        {
          rollbackPerformed: true,
          rollbackErrors,
          syncedAgentIds,
          cause: error instanceof Error ? error.message : "Skill coverage repair failed.",
        },
      );
    }

    const nextAudit = await coverageAudit(companyId);
    return {
      companyId,
      changedAgentCount: changedPlans.length,
      appliedAgentIds: changedPlans.map((entry) => entry.agent.id),
      importedSkills,
      rollbackPerformed: false,
      rollbackErrors: [],
      selectionFingerprint: plan.preview.selectionFingerprint,
      audit: nextAudit,
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
    coverageAudit,
    previewCoverageRepair,
    applyCoverageRepair,
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

import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, agentProjectScopes, projects } from "@paperclipai/db";
import type {
  AgentProjectPlacementInput,
  AgentProjectRole,
  AgentProjectScopeMode,
  ActorPrincipalKind,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";

type PlacementSubject = {
  companyId: string;
  operatingClass: string | null | undefined;
  archetypeKey: string | null | undefined;
  status?: string | null | undefined;
};

type PlacementActor = {
  principalType: ActorPrincipalKind;
  principalId: string | null;
};

export type ResolvedPrimaryProjectPlacement = {
  projectId: string;
  scopeMode: AgentProjectScopeMode;
  projectRole: AgentProjectRole;
  teamFunctionKey: string | null;
  teamFunctionLabel: string | null;
  workstreamKey: string | null;
  workstreamLabel: string | null;
  requestedReason: string | null;
};

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function inferPlacementDefaults(
  subject: PlacementSubject,
): Pick<ResolvedPrimaryProjectPlacement, "scopeMode" | "projectRole"> | null {
  if (subject.operatingClass === "worker") {
    return {
      scopeMode: "execution",
      projectRole: "worker",
    };
  }

  if (subject.operatingClass !== "project_leadership") {
    return null;
  }

  const archetypeKey = normalizeOptionalText(subject.archetypeKey)?.toLowerCase() ?? null;
  if (!archetypeKey) return null;

  if (archetypeKey === "project_director") {
    return {
      scopeMode: "leadership_raw",
      projectRole: "director",
    };
  }

  if (
    archetypeKey === "project_lead"
    || archetypeKey === "project_tech_lead"
    || archetypeKey === "technical_project_lead"
  ) {
    return {
      scopeMode: "leadership_raw",
      projectRole: "engineering_manager",
    };
  }

  if (archetypeKey.includes("team_lead")) {
    return {
      scopeMode: "leadership_raw",
      projectRole: "functional_lead",
    };
  }

  return null;
}

function isSupportedLeadershipProjectRole(projectRole: AgentProjectRole) {
  return (
    projectRole === "director"
    || projectRole === "engineering_manager"
    || projectRole === "functional_lead"
    || projectRole === "product_manager"
  );
}

function resolveEffectivePlacement(
  subject: PlacementSubject,
  placement: AgentProjectPlacementInput,
): ResolvedPrimaryProjectPlacement {
  if (subject.status === "terminated") {
    throw unprocessable("Terminated agents cannot receive project placement");
  }
  if (subject.operatingClass === "executive") {
    throw unprocessable("Executives cannot receive direct primary project placement");
  }
  if (subject.operatingClass === "shared_service_lead") {
    throw unprocessable("Shared-service leads must use shared-service engagement flows");
  }
  if (subject.operatingClass === "consultant") {
    throw unprocessable("Consultants must use shared-service engagement flows");
  }

  const inferred = inferPlacementDefaults(subject);
  const projectRole = placement.projectRole ?? inferred?.projectRole ?? null;
  const scopeMode = placement.scopeMode ?? inferred?.scopeMode ?? null;

  if (!projectRole || !scopeMode) {
    throw unprocessable(
      "Project placement is ambiguous for this agent. Supply explicit projectRole and scopeMode overrides.",
    );
  }

  if (scopeMode !== "execution" && scopeMode !== "leadership_raw") {
    throw unprocessable("Primary project placement only supports execution or leadership_raw scope modes");
  }

  if (projectRole === "worker") {
    if (scopeMode !== "execution") {
      throw unprocessable("Worker placement must use execution scope mode");
    }
    if (subject.operatingClass !== "worker") {
      throw unprocessable("Only worker-class agents can receive worker project placement");
    }
  } else {
    if (!isSupportedLeadershipProjectRole(projectRole)) {
      throw unprocessable("Primary project placement only supports project pod leadership roles");
    }
    if (scopeMode !== "leadership_raw") {
      throw unprocessable("Leadership placement must use leadership_raw scope mode");
    }
    if (subject.operatingClass === "worker") {
      throw unprocessable("Worker-class agents cannot receive leadership project placement");
    }
  }

  return {
    projectId: placement.projectId,
    scopeMode,
    projectRole,
    teamFunctionKey: normalizeOptionalText(placement.teamFunctionKey),
    teamFunctionLabel: normalizeOptionalText(placement.teamFunctionLabel),
    workstreamKey: normalizeOptionalText(placement.workstreamKey),
    workstreamLabel: normalizeOptionalText(placement.workstreamLabel),
    requestedReason: normalizeOptionalText(placement.requestedReason),
  };
}

export function agentProjectPlacementService(db: Db) {
  async function assertProjectRow(
    companyId: string,
    projectId: string,
    dbOrTx: Pick<Db, "select"> = db,
  ) {
    const project = await dbOrTx
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .then((rows) => rows[0] ?? null);
    if (!project) throw notFound("Project not found");
    if (project.companyId !== companyId) {
      throw unprocessable("Project placement must target a project in the same company");
    }
    return project;
  }

  async function assertAgentRow(
    companyId: string,
    agentId: string,
    dbOrTx: Pick<Db, "select"> = db,
  ) {
    const agent = await dbOrTx
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Agent not found");
    if (agent.companyId !== companyId) {
      throw unprocessable("Agent placement must target an agent in the same company");
    }
    return agent;
  }

  return {
    previewForInput: async (
      companyId: string,
      subject: PlacementSubject,
      placement: AgentProjectPlacementInput,
    ) => {
      await assertProjectRow(companyId, placement.projectId);
      return resolveEffectivePlacement(subject, placement);
    },

    applyPrimaryPlacement: async (input: {
      companyId: string;
      agentId: string;
      placement: AgentProjectPlacementInput;
      actor: PlacementActor;
    }) => {
      const agent = await assertAgentRow(input.companyId, input.agentId);
      await assertProjectRow(input.companyId, input.placement.projectId);
      const resolved = resolveEffectivePlacement(agent, input.placement);
      const now = new Date();

      const scope = await db.transaction(async (tx) => {
        await tx
          .update(agentProjectScopes)
          .set({ activeTo: now, updatedAt: now })
          .where(
            and(
              eq(agentProjectScopes.companyId, input.companyId),
              eq(agentProjectScopes.agentId, input.agentId),
              eq(agentProjectScopes.isPrimary, true),
              isNull(agentProjectScopes.activeTo),
            ),
          );

        await tx
          .update(agents)
          .set({
            requestedForProjectId: resolved.projectId,
            requestedReason: resolved.requestedReason,
            updatedAt: now,
          })
          .where(eq(agents.id, input.agentId));

        const inserted = await tx
          .insert(agentProjectScopes)
          .values({
            companyId: input.companyId,
            agentId: input.agentId,
            projectId: resolved.projectId,
            scopeMode: resolved.scopeMode,
            projectRole: resolved.projectRole,
            isPrimary: true,
            teamFunctionKey: resolved.teamFunctionKey,
            teamFunctionLabel: resolved.teamFunctionLabel,
            workstreamKey: resolved.workstreamKey,
            workstreamLabel: resolved.workstreamLabel,
            grantedByPrincipalType: input.actor.principalType,
            grantedByPrincipalId: input.actor.principalId,
            activeFrom: now,
            activeTo: null,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .then((rows) => rows[0]!);

        return inserted;
      });

      return { scope, resolved };
    },
  };
}

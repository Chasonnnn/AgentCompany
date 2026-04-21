import { logger } from "../middleware/logger.js";
import { officeCoordinationService } from "./office-coordination.js";

type OfficeCoordinationWakeService = Pick<
  ReturnType<typeof officeCoordinationService>,
  "findOfficeOperator" | "buildWakeSnapshot"
>;

type OfficeCoordinationHeartbeat = Pick<
  ReturnType<(typeof import("./heartbeat.js"))["heartbeatService"]>,
  "wakeup"
>;

export async function wakeCompanyOfficeOperator(input: {
  officeCoordination: OfficeCoordinationWakeService;
  heartbeat: OfficeCoordinationHeartbeat;
  companyId: string;
  reason: string;
  entityType?: string | null;
  entityId?: string | null;
  summary?: string | null;
  requestedByActorType?: "user" | "agent" | "system" | null;
  requestedByActorId?: string | null;
  skipIfActorAgentId?: string | null;
}) {
  const officeAgent = await input.officeCoordination.findOfficeOperator(input.companyId);
  if (!officeAgent) return null;
  if (input.skipIfActorAgentId && officeAgent.id === input.skipIfActorAgentId) {
    return null;
  }

  const trigger = {
    reason: input.reason,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    summary: input.summary ?? null,
  };
  const snapshot = await input.officeCoordination.buildWakeSnapshot({
    companyId: input.companyId,
    officeAgentId: officeAgent.id,
    trigger,
  });

  await input.heartbeat.wakeup(officeAgent.id, {
    source: "automation",
    triggerDetail: "system",
    reason: "office_coordination_requested",
    requestedByActorType: input.requestedByActorType ?? "system",
    requestedByActorId: input.requestedByActorId ?? "office_coordination",
    contextSnapshot: {
      wakeReason: "office_coordination_requested",
      paperclipOfficeCoordination: snapshot,
    },
  });

  return officeAgent;
}

export async function wakeCompanyOfficeOperatorSafely(
  input: Parameters<typeof wakeCompanyOfficeOperator>[0] & {
    logContext?: Record<string, unknown>;
  },
) {
  try {
    return await wakeCompanyOfficeOperator(input);
  } catch (err) {
    logger.warn(
      {
        err,
        companyId: input.companyId,
        reason: input.reason,
        ...(input.logContext ?? {}),
      },
      "failed to wake company office operator",
    );
    return null;
  }
}

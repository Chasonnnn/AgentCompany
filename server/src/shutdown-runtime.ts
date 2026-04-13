import { runningProcesses } from "./adapters/index.js";
import { logger } from "./middleware/logger.js";
import { terminateLocalService } from "./services/local-service-supervisor.js";

export async function stopRunningAdapterProcesses() {
  const entries = Array.from(runningProcesses.entries());
  if (entries.length === 0) {
    return { attempted: 0, signaled: 0 };
  }

  let signaled = 0;
  await Promise.allSettled(
    entries.map(async ([runId, running]) => {
      const pid = running.child.pid;
      if (typeof pid !== "number" || pid <= 0) {
        logger.warn({ runId }, "Skipping shutdown cleanup for adapter child without a live pid");
        return;
      }

      signaled += 1;
      try {
        await terminateLocalService(
          {
            pid,
            processGroupId: running.processGroupId ?? null,
          },
          {
            signal: "SIGTERM",
            forceAfterMs: Math.max(1, running.graceSec) * 1000,
          },
        );
      } catch (err) {
        logger.warn(
          {
            err,
            runId,
            pid,
            processGroupId: running.processGroupId ?? null,
          },
          "Failed to stop adapter child during shutdown",
        );
      }
    }),
  );

  runningProcesses.clear();
  return { attempted: entries.length, signaled };
}

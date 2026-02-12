export const SessionStatuses = ["running", "ended", "failed", "stopped"] as const;

export type SessionStatus = (typeof SessionStatuses)[number];

const ALLOWED_TRANSITIONS: Record<SessionStatus, ReadonlySet<SessionStatus>> = {
  running: new Set<SessionStatus>(["running", "ended", "failed", "stopped"]),
  ended: new Set<SessionStatus>(["ended"]),
  failed: new Set<SessionStatus>(["failed"]),
  stopped: new Set<SessionStatus>(["stopped"])
};

export function transitionSessionStatus(
  current: SessionStatus,
  next: SessionStatus
): SessionStatus {
  const allowed = ALLOWED_TRANSITIONS[current];
  if (allowed.has(next)) return next;
  throw new Error(`Invalid session status transition: ${current} -> ${next}`);
}

export function isTerminalSessionStatus(status: SessionStatus): boolean {
  return status === "ended" || status === "failed" || status === "stopped";
}

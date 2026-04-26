// Adapter trust marker — defense-in-depth for the D-NEW-8 adapter-escape class
// (AIW-155). Server-layer trust policy in routes/* already gates today's exploit;
// this marker defends against a future refactor that reaches an adapter through
// an untouched code path (direct import, test harness, background worker) and
// regenerates the exploit without tripping the API-boundary gate.
//
// Design: every adapter that enters the server registry is stamped with a
// well-known symbol at registration time. Registry lookups used by live-use
// sites (heartbeat execute, skill sync, session codec, testEnvironment, hire
// hook, evals) route through the lookup chokepoints exported from registry.ts,
// which call assertAdapterTrusted before returning. Synthesising a
// ServerAdapterModule-shaped value and handing it straight to live-use code
// without going through registerServerAdapter() will therefore fail closed.
//
// The marker is a Symbol.for key (registered on the global symbol registry) so
// it is identity-stable across ESM duplication but still cannot be produced by
// JSON deserialization or cross-process messaging — which is intentional: an
// adapter that only survives as JSON is, by definition, no longer a live adapter
// and must not be invoked.

export const ADAPTER_TRUST_MARKER = Symbol.for("paperclip.adapter.trusted");

type WithMarker = Record<symbol, unknown>;

/**
 * Stamp an adapter as trusted. Called by registry.ts at every registration
 * path (built-in registration, external adapter resolution, registerServerAdapter).
 * Mutates the input object so that subsequent spreads, lookups, and reference
 * comparisons preserve the marker without reallocating.
 */
export function markAdapterTrusted<T extends object>(adapter: T): T {
  (adapter as unknown as WithMarker)[ADAPTER_TRUST_MARKER] = true;
  return adapter;
}

/** True when the value carries the adapter trust marker set to true. */
export function isAdapterTrusted(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  return (value as WithMarker)[ADAPTER_TRUST_MARKER] === true;
}

/**
 * Throw a clean error when an adapter reaches a live-use site without the
 * trust marker. opLabel names the live-use operation so the error is
 * diagnosable in logs without exposing adapter internals.
 */
export function assertAdapterTrusted(
  adapter: unknown,
  opLabel: string = "live-use",
): void {
  if (isAdapterTrusted(adapter)) return;
  throw new Error(
    `Refusing to ${opLabel}: adapter is missing the paperclip.adapter.trusted ` +
      `marker. Adapters must be registered via registerServerAdapter() or the ` +
      `built-in registration path before live use (AIW-155 / D-NEW-8).`,
  );
}

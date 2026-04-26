import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { ServerAdapterModule } from "../adapters/index.js";
import {
  ADAPTER_TRUST_MARKER,
  assertAdapterTrusted,
  findActiveServerAdapter,
  isAdapterTrusted,
  markAdapterTrusted,
  registerServerAdapter,
  requireServerAdapter,
  resetServerAdaptersForTests,
  unregisterServerAdapter,
  getServerAdapter,
} from "../adapters/index.js";
import { resolveExternalAdapterRegistration } from "../adapters/registry.js";

function makeUnmarkedAdapter(type: string): ServerAdapterModule {
  return {
    type,
    execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
    testEnvironment: async () => ({
      adapterType: type,
      status: "pass",
      checks: [],
      testedAt: new Date(0).toISOString(),
    }),
  };
}

describe("adapter trust marker (AIW-155 / D-NEW-8)", () => {
  beforeEach(() => {
    resetServerAdaptersForTests();
  });

  afterEach(() => {
    unregisterServerAdapter("trust_test");
    resetServerAdaptersForTests();
  });

  describe("marker primitives", () => {
    it("stamps a well-known symbol on the adapter instance", () => {
      const adapter = makeUnmarkedAdapter("trust_test");
      expect(isAdapterTrusted(adapter)).toBe(false);

      markAdapterTrusted(adapter);

      expect(isAdapterTrusted(adapter)).toBe(true);
      expect(
        (adapter as unknown as Record<symbol, unknown>)[ADAPTER_TRUST_MARKER],
      ).toBe(true);
    });

    it("marks-in-place so object identity survives the stamp", () => {
      const adapter = makeUnmarkedAdapter("trust_test");
      const returned = markAdapterTrusted(adapter);

      expect(returned).toBe(adapter);
    });

    it("isAdapterTrusted rejects non-object values without throwing", () => {
      expect(isAdapterTrusted(null)).toBe(false);
      expect(isAdapterTrusted(undefined)).toBe(false);
      expect(isAdapterTrusted("adapter")).toBe(false);
      expect(isAdapterTrusted(42)).toBe(false);
      expect(isAdapterTrusted({})).toBe(false);
    });

    it("assertAdapterTrusted throws a clean, diagnosable error on unmarked adapters", () => {
      const adapter = makeUnmarkedAdapter("trust_test");
      expect(() => assertAdapterTrusted(adapter, "spawn.execute")).toThrow(
        /paperclip\.adapter\.trusted marker/,
      );
      expect(() => assertAdapterTrusted(adapter, "spawn.execute")).toThrow(
        /spawn\.execute/,
      );
    });

    it("assertAdapterTrusted is a no-op on marked adapters", () => {
      const adapter = markAdapterTrusted(makeUnmarkedAdapter("trust_test"));
      expect(() => assertAdapterTrusted(adapter)).not.toThrow();
    });
  });

  describe("registry stamps adapters at every registration path", () => {
    it("built-in adapters carry the marker immediately after reset (happy path)", () => {
      // registerBuiltInAdapters runs inside resetServerAdaptersForTests and stamps each built-in.
      const claude = findActiveServerAdapter("claude_local");
      expect(claude).not.toBeNull();
      expect(isAdapterTrusted(claude)).toBe(true);
    });

    it("registerServerAdapter marks the adapter instance it stores", () => {
      const external = makeUnmarkedAdapter("trust_test");
      expect(isAdapterTrusted(external)).toBe(false);

      registerServerAdapter(external);

      const resolved = requireServerAdapter("trust_test");
      expect(resolved).toBe(external);
      expect(isAdapterTrusted(resolved)).toBe(true);
    });

    it("resolveExternalAdapterRegistration returns a marked copy (marker round-trip through the factory)", () => {
      const raw = makeUnmarkedAdapter("trust_test");
      expect(isAdapterTrusted(raw)).toBe(false);

      const resolved = resolveExternalAdapterRegistration(raw);

      expect(isAdapterTrusted(resolved)).toBe(true);
      // The original input is not mutated — trust lives on the returned factory output.
      expect(isAdapterTrusted(raw)).toBe(false);
    });
  });

  describe("fail-closed at live-use lookup chokepoints (unmarked adapter rejection)", () => {
    // Simulate a future refactor that reaches the adapter map through an
    // untouched code path (direct import, test harness, background worker)
    // and leaves an adapter without the trust marker. The lookup chokepoints
    // must fail closed.
    //
    // We model that by registering an adapter (which stamps it), then stripping
    // the marker. The map still references the same object, now untrusted —
    // indistinguishable at the lookup layer from an adapter that was never
    // stamped in the first place.
    function seatUnmarked(type: string): ServerAdapterModule {
      const adapter = makeUnmarkedAdapter(type);
      registerServerAdapter(adapter);
      delete (adapter as unknown as Record<symbol, unknown>)[
        ADAPTER_TRUST_MARKER
      ];
      return adapter;
    }

    it("findActiveServerAdapter throws when the stored adapter is missing the marker", () => {
      seatUnmarked("trust_test");

      expect(() => findActiveServerAdapter("trust_test")).toThrow(
        /paperclip\.adapter\.trusted/,
      );
    });

    it("requireServerAdapter throws when the stored adapter is missing the marker", () => {
      seatUnmarked("trust_test");

      expect(() => requireServerAdapter("trust_test")).toThrow(
        /paperclip\.adapter\.trusted/,
      );
    });

    it("getServerAdapter throws when the stored adapter is missing the marker (no silent fallback)", () => {
      seatUnmarked("trust_test");

      expect(() => getServerAdapter("trust_test")).toThrow(
        /paperclip\.adapter\.trusted/,
      );
    });

    it("getServerAdapter on an unknown type still returns the trusted guarded fallback", () => {
      // guardedProcessAdapter is stamped during registerBuiltInAdapters; an
      // unknown type resolves through the fallback and must remain live.
      const adapter = getServerAdapter("definitely_not_a_real_adapter_type");
      expect(isAdapterTrusted(adapter)).toBe(true);
    });
  });

  describe("spread / factory copy preserves the marker (serialization boundary for in-process spreads)", () => {
    it("object spread copies the symbol-keyed marker onto a clone (legitimate in-process pass-through)", () => {
      const original = markAdapterTrusted(makeUnmarkedAdapter("trust_test"));
      const clone: ServerAdapterModule = { ...original };

      // Object spread copies own enumerable symbol-keyed properties per spec,
      // so legitimate in-process factories (e.g. guardedProcessAdapter wrappers
      // that spread an underlying module) preserve trust without needing to
      // re-mark. resolveExternalAdapterRegistration still re-marks explicitly
      // for belt-and-suspenders.
      expect(isAdapterTrusted(clone)).toBe(true);
    });

    it("JSON round-trip strips the marker — serialized adapters are not live adapters (documented behavior)", () => {
      const original = markAdapterTrusted(makeUnmarkedAdapter("trust_test"));
      const roundTripped = JSON.parse(JSON.stringify(original));

      expect(isAdapterTrusted(roundTripped)).toBe(false);
    });
  });
});

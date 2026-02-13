import { describe, expect, test } from "vitest";
import {
  withLaunchLane,
  readLaunchLaneStatsForWorkspace,
  reportProviderBackpressure,
  clearProviderCooldown
} from "../src/runtime/launch_lane.js";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("launch lane scheduler", () => {
  test("serializes launches for the same workspace", async () => {
    const workspace = "/tmp/ws-a";
    const order: string[] = [];

    const one = withLaunchLane(workspace, async () => {
      order.push("one:start");
      await sleep(40);
      order.push("one:end");
      return 1;
    });
    const two = withLaunchLane(workspace, async () => {
      order.push("two:start");
      await sleep(10);
      order.push("two:end");
      return 2;
    });

    const [r1, r2] = await Promise.all([one, two]);
    expect(r1).toBe(1);
    expect(r2).toBe(2);
    expect(order).toEqual(["one:start", "one:end", "two:start", "two:end"]);
  });

  test("tracks pending/running stats while queued", async () => {
    const workspace = "/tmp/ws-b";

    const first = withLaunchLane(workspace, async () => {
      await sleep(50);
      return "a";
    });
    const second = withLaunchLane(workspace, async () => "b");
    await sleep(10);

    const stats = readLaunchLaneStatsForWorkspace(workspace);
    expect(stats.pending).toBeGreaterThanOrEqual(1);
    expect(stats.running).toBe(1);

    await Promise.all([first, second]);
    const after = readLaunchLaneStatsForWorkspace(workspace);
    expect(after.pending).toBe(0);
    expect(after.running).toBe(0);
  });

  test("respects provider-level concurrency limits", async () => {
    const workspace = "/tmp/ws-c";
    const events: string[] = [];
    let codexRunning = 0;
    let maxCodexRunning = 0;

    const a1 = withLaunchLane(
      workspace,
      { provider: "codex", workspace_limit: 2, provider_limit: 1 },
      async () => {
        codexRunning += 1;
        maxCodexRunning = Math.max(maxCodexRunning, codexRunning);
        events.push("a1:start");
        await sleep(45);
        events.push("a1:end");
        codexRunning = Math.max(0, codexRunning - 1);
        return "a1";
      }
    );
    const a2 = withLaunchLane(
      workspace,
      { provider: "codex", workspace_limit: 2, provider_limit: 1 },
      async () => {
        codexRunning += 1;
        maxCodexRunning = Math.max(maxCodexRunning, codexRunning);
        events.push("a2:start");
        await sleep(10);
        events.push("a2:end");
        codexRunning = Math.max(0, codexRunning - 1);
        return "a2";
      }
    );
    const b1 = withLaunchLane(
      workspace,
      { provider: "claude", workspace_limit: 2, provider_limit: 1 },
      async () => {
        events.push("b1:start");
        await sleep(10);
        events.push("b1:end");
        return "b1";
      }
    );

    await Promise.all([a1, a2, b1]);

    const a1Start = events.indexOf("a1:start");
    const a1End = events.indexOf("a1:end");
    const a2Start = events.indexOf("a2:start");

    expect(a1Start).toBeGreaterThanOrEqual(0);
    expect(a2Start).toBeGreaterThanOrEqual(0);
    expect(a2Start).toBeGreaterThan(a1End);
    expect(maxCodexRunning).toBe(1);
  });

  test("prioritizes high-priority launches over queued normal launches", async () => {
    const workspace = "/tmp/ws-d";
    const order: string[] = [];

    const first = withLaunchLane(
      workspace,
      { priority: "normal", workspace_limit: 1 },
      async () => {
        order.push("first:start");
        await sleep(35);
        order.push("first:end");
      }
    );
    await sleep(5);
    const normal = withLaunchLane(
      workspace,
      { priority: "normal", workspace_limit: 1 },
      async () => {
        order.push("normal:start");
        await sleep(5);
        order.push("normal:end");
      }
    );
    const high = withLaunchLane(
      workspace,
      { priority: "high", workspace_limit: 1 },
      async () => {
        order.push("high:start");
        await sleep(5);
        order.push("high:end");
      }
    );

    await Promise.all([first, normal, high]);

    expect(order).toEqual([
      "first:start",
      "first:end",
      "high:start",
      "high:end",
      "normal:start",
      "normal:end"
    ]);
  });

  test("enforces provider cooldown after backpressure reports", async () => {
    const workspace = "/tmp/ws-e";
    const started: string[] = [];
    reportProviderBackpressure(workspace, "codex", "429", {
      base_cooldown_ms: 90,
      max_cooldown_ms: 90
    });

    const beganAt = Date.now();
    const run = withLaunchLane(
      workspace,
      { provider: "codex", workspace_limit: 2, provider_limit: 2 },
      async () => {
        started.push("started");
      }
    );

    await sleep(20);
    expect(started).toEqual([]);
    const midStats = readLaunchLaneStatsForWorkspace(workspace);
    expect(midStats.provider_cooldowns.codex).toBeDefined();
    await run;
    const elapsed = Date.now() - beganAt;
    expect(elapsed).toBeGreaterThanOrEqual(70);
    expect(started).toEqual(["started"]);
  });

  test("clearProviderCooldown releases queued provider work immediately", async () => {
    const workspace = "/tmp/ws-f";
    reportProviderBackpressure(workspace, "claude", "429", {
      base_cooldown_ms: 500,
      max_cooldown_ms: 500
    });
    const started: string[] = [];
    const run = withLaunchLane(
      workspace,
      { provider: "claude", workspace_limit: 1, provider_limit: 1 },
      async () => {
        started.push("ok");
      }
    );
    await sleep(25);
    expect(started).toEqual([]);
    clearProviderCooldown(workspace, "claude");
    await run;
    expect(started).toEqual(["ok"]);
  });
});

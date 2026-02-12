import { describe, expect, test } from "vitest";
import { withLaunchLane, readLaunchLaneStatsForWorkspace } from "../src/runtime/launch_lane.js";

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
});

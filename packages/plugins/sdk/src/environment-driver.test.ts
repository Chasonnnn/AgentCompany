import { describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "./types.js";
import {
  assertEnvironmentEventOrder,
  assertExecutionLifecycle,
  assertLeaseLifecycle,
  createEnvironmentTestHarness,
  createFakeEnvironmentDriver,
} from "./testing.js";
import { HOST_TO_WORKER_OPTIONAL_METHODS } from "./protocol.js";

const manifest: PaperclipPluginManifestV1 = {
  id: "test.environment-driver",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Test Environment Driver",
  description: "Test environment driver",
  author: "Paperclip",
  categories: ["connector"],
  capabilities: [],
  entrypoints: {
    worker: "./dist/worker.js",
  },
};

describe("plugin environment driver SDK helpers", () => {
  it("exposes environment driver RPC methods as optional worker handlers", () => {
    expect(HOST_TO_WORKER_OPTIONAL_METHODS).toEqual(expect.arrayContaining([
      "environmentValidateConfig",
      "environmentProbe",
      "environmentAcquireLease",
      "environmentResumeLease",
      "environmentReleaseLease",
      "environmentDestroyLease",
      "environmentRealizeWorkspace",
      "environmentExecute",
    ]));
  });

  it("records environment lifecycle events through the test harness", async () => {
    const harness = createEnvironmentTestHarness({
      manifest,
      environmentDriver: createFakeEnvironmentDriver({ driverKey: "fake-sandbox" }),
    });
    const base = {
      driverKey: "fake-sandbox",
      companyId: "company-1",
      environmentId: "env-1",
      config: { image: "test" },
    };

    await harness.validateConfig({ driverKey: base.driverKey, config: base.config });
    await harness.probe(base);
    const lease = await harness.acquireLease({ ...base, runId: "run-1", requestedCwd: "/workspace" });
    await harness.realizeWorkspace({
      ...base,
      lease,
      workspace: { localPath: "/tmp/local", remotePath: "/workspace" },
    });
    await harness.execute({
      ...base,
      lease,
      command: "echo",
      args: ["ok"],
      cwd: "/workspace",
    });
    await harness.releaseLease({ ...base, providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata });

    assertEnvironmentEventOrder(harness.environmentEvents, [
      "validateConfig",
      "probe",
      "acquireLease",
      "realizeWorkspace",
      "execute",
      "releaseLease",
    ]);
    expect(assertLeaseLifecycle(harness.environmentEvents, "env-1").acquire.result).toMatchObject({
      providerLeaseId: "fake-lease-1",
    });
    expect(assertExecutionLifecycle(harness.environmentEvents, "env-1")).toHaveLength(1);
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createWorkspaceDiagnosticsBundle } from "../src/workspace/diagnostics.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

describe("workspace diagnostics bundle", () => {
  test("writes diagnostics JSON artifacts and manifest", async () => {
    const dir = await mkTmpDir();
    const out = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });

    const res = await createWorkspaceDiagnosticsBundle({
      workspace_dir: dir,
      out_dir: out,
      sync_index: true
    });

    expect(res.workspace_dir).toBe(dir);
    expect(res.out_dir).toBe(out);
    expect(await fs.stat(res.bundle_dir)).toBeDefined();

    const manifestPath = path.join(res.bundle_dir, res.files.manifest);
    const doctorPath = path.join(res.bundle_dir, res.files.doctor);
    const monitorPath = path.join(res.bundle_dir, res.files.monitor_snapshot);
    const inboxPath = path.join(res.bundle_dir, res.files.review_inbox_snapshot);

    const manifest = JSON.parse(await fs.readFile(manifestPath, { encoding: "utf8" })) as Record<
      string,
      unknown
    >;
    expect(manifest.type).toBe("workspace_diagnostics");
    expect(manifest.schema_version).toBe(1);
    expect(typeof manifest.generated_at).toBe("string");

    const doctor = JSON.parse(await fs.readFile(doctorPath, { encoding: "utf8" })) as Record<
      string,
      unknown
    >;
    expect(Array.isArray(doctor.checks)).toBe(true);

    const monitor = JSON.parse(await fs.readFile(monitorPath, { encoding: "utf8" })) as Record<
      string,
      unknown
    >;
    expect(Array.isArray(monitor.rows)).toBe(true);

    const inbox = JSON.parse(await fs.readFile(inboxPath, { encoding: "utf8" })) as Record<
      string,
      unknown
    >;
    expect(Array.isArray(inbox.pending)).toBe(true);
    expect(Array.isArray(inbox.recent_decisions)).toBe(true);
  });
});

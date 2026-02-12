import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { desktopReleaseDoctor } from "../src/ui/desktop_release_doctor.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

describe("desktop release doctor", () => {
  test("fails when tauri config is missing", async () => {
    const dir = await mkTmpDir();
    const report = await desktopReleaseDoctor({ cwd: dir, env: {} });
    const cfg = report.checks.find((c) => c.id === "release.tauri_config");
    expect(cfg?.status).toBe("fail");
    expect(report.ok).toBe(false);
  });

  test("passes core release checks when updater/channels/signing are configured", async () => {
    const dir = await mkTmpDir();
    const tauriDir = path.join(dir, "src-tauri");
    await fs.mkdir(tauriDir, { recursive: true });
    await fs.writeFile(
      path.join(tauriDir, "tauri.conf.json"),
      `${JSON.stringify(
        {
          productName: "AgentCompany",
          version: "1.2.3",
          identifier: "com.agentcompany.desktop",
          bundle: { active: true, targets: "all" },
          plugins: {
            updater: {
              active: true,
              pubkey: "test_pubkey",
              endpoints: ["https://updates.example.com/alpha.json"]
            }
          }
        },
        null,
        2
      )}\n`,
      { encoding: "utf8" }
    );
    await fs.writeFile(
      path.join(tauriDir, "release-channels.json"),
      `${JSON.stringify(
        {
          alpha: { endpoint: "https://updates.example.com/alpha.json" },
          beta: { endpoint: "https://updates.example.com/beta.json" },
          stable: { endpoint: "https://updates.example.com/stable.json" }
        },
        null,
        2
      )}\n`,
      { encoding: "utf8" }
    );

    const env: NodeJS.ProcessEnv = {
      TAURI_SIGNING_PRIVATE_KEY: "test_private_key"
    };
    if (process.platform === "darwin") {
      env.APPLE_SIGNING_IDENTITY = "Developer ID Application: Example Inc";
      env.APPLE_TEAM_ID = "ABCDE12345";
    }
    const report = await desktopReleaseDoctor({ cwd: dir, env });
    const updater = report.checks.find((c) => c.id === "release.updater");
    expect(updater?.status).toBe("pass");
    expect(report.summary.fail).toBe(0);
  });
});

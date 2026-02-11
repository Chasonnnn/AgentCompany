import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createProject } from "../src/work/projects.js";
import { desktopDoctor, type CommandProbe } from "../src/ui/desktop_doctor.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

function stubProbe(overrides: Record<string, { ok: boolean; stdout?: string; stderr?: string }> = {}): CommandProbe {
  return async (cmd: string, args: string[]) => {
    const key = `${cmd} ${args.join(" ")}`.trim();
    if (overrides[key]) {
      const o = overrides[key];
      return {
        ok: o.ok,
        exit_code: o.ok ? 0 : 1,
        stdout: o.stdout ?? "",
        stderr: o.stderr ?? (o.ok ? "" : "error")
      };
    }
    return {
      ok: true,
      exit_code: 0,
      stdout: "ok",
      stderr: ""
    };
  };
}

describe("desktop doctor", () => {
  test("fails readiness when rust toolchain checks fail", async () => {
    const dir = await mkTmpDir();
    const cliPath = path.join(dir, "dist", "cli.js");
    await fs.mkdir(path.dirname(cliPath), { recursive: true });
    await fs.writeFile(cliPath, "#!/usr/bin/env node\n", { encoding: "utf8" });

    const report = await desktopDoctor(
      {
        cli_path: cliPath,
        node_bin: process.execPath
      },
      {
        probe_command: stubProbe({
          "rustc --version": { ok: false, stderr: "command not found" },
          "cargo --version": { ok: false, stderr: "command not found" },
          "pnpm exec tauri --version": { ok: true, stdout: "tauri-cli 2.10.0" }
        })
      }
    );

    const rustc = report.checks.find((c) => c.id === "desktop.rustc");
    const cargo = report.checks.find((c) => c.id === "desktop.cargo");
    expect(rustc?.status).toBe("fail");
    expect(cargo?.status).toBe("fail");
    expect(report.ok).toBe(false);
  });

  test("passes readiness when required binaries and workspace/project are present", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });

    const cliPath = path.join(dir, "dist", "cli.js");
    await fs.mkdir(path.dirname(cliPath), { recursive: true });
    await fs.writeFile(cliPath, "#!/usr/bin/env node\n", { encoding: "utf8" });

    const report = await desktopDoctor(
      {
        workspace_dir: dir,
        project_id,
        cli_path: cliPath,
        node_bin: process.execPath
      },
      {
        probe_command: stubProbe({
          "rustc --version": { ok: true, stdout: "rustc 1.84.0" },
          "cargo --version": { ok: true, stdout: "cargo 1.84.0" },
          "pnpm exec tauri --version": { ok: true, stdout: "tauri-cli 2.10.0" }
        })
      }
    );

    expect(report.ok).toBe(true);
    expect(report.summary.fail).toBe(0);
  });

  test("fails when project_id is provided but project path is missing", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });

    const cliPath = path.join(dir, "dist", "cli.js");
    await fs.mkdir(path.dirname(cliPath), { recursive: true });
    await fs.writeFile(cliPath, "#!/usr/bin/env node\n", { encoding: "utf8" });

    const report = await desktopDoctor(
      {
        workspace_dir: dir,
        project_id: "proj_missing",
        cli_path: cliPath,
        node_bin: process.execPath
      },
      {
        probe_command: stubProbe({
          "rustc --version": { ok: true, stdout: "rustc 1.84.0" },
          "cargo --version": { ok: true, stdout: "cargo 1.84.0" },
          "pnpm exec tauri --version": { ok: true, stdout: "tauri-cli 2.10.0" }
        })
      }
    );

    const projectCheck = report.checks.find((c) => c.id === "desktop.project");
    expect(projectCheck?.status).toBe("fail");
    expect(report.ok).toBe(false);
  });
});

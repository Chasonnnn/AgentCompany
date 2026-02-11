import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

export type DesktopDoctorCheckStatus = "pass" | "warn" | "fail";

export type DesktopDoctorCheck = {
  id: string;
  status: DesktopDoctorCheckStatus;
  message: string;
  details?: string[];
};

export type DesktopDoctorResult = {
  ok: boolean;
  checks: DesktopDoctorCheck[];
  summary: {
    pass: number;
    warn: number;
    fail: number;
  };
  resolved: {
    cli_path?: string;
    node_bin: string;
  };
};

export type DesktopDoctorArgs = {
  workspace_dir?: string;
  project_id?: string;
  cli_path?: string;
  node_bin?: string;
};

export type CommandProbeResult = {
  ok: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

export type CommandProbe = (cmd: string, args: string[]) => Promise<CommandProbeResult>;

export type DesktopDoctorDeps = {
  probe_command?: CommandProbe;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

async function pathExists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}

async function pathExecutable(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function trimOutput(v: string, max = 200): string {
  const s = v.trim();
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

export async function defaultProbeCommand(cmd: string, args: string[]): Promise<CommandProbeResult> {
  return await new Promise<CommandProbeResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      p.kill();
      resolve({ ok: false, exit_code: null, stdout, stderr, error: "timed out" });
    }, 5000);
    timeout.unref?.();

    p.stdout?.on("data", (chunk) => {
      if (settled) return;
      stdout += String(chunk);
      if (stdout.length > 4096) stdout = stdout.slice(0, 4096);
    });

    p.stderr?.on("data", (chunk) => {
      if (settled) return;
      stderr += String(chunk);
      if (stderr.length > 4096) stderr = stderr.slice(0, 4096);
    });

    p.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ok: false, exit_code: null, stdout, stderr, error: e.message });
    });

    p.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ok: code === 0, exit_code: code, stdout, stderr });
    });
  });
}

function resolveNodeBin(args: DesktopDoctorArgs, env: NodeJS.ProcessEnv): string {
  const fromArg = args.node_bin?.trim();
  if (fromArg) return fromArg;
  const fromEnv = env.AGENTCOMPANY_NODE_BIN?.trim();
  if (fromEnv) return fromEnv;
  return "node";
}

function isPathLike(v: string): boolean {
  return v.includes("/") || v.startsWith(".");
}

function resolveCliCandidates(args: DesktopDoctorArgs, env: NodeJS.ProcessEnv, cwd: string): string[] {
  const candidates: string[] = [];
  const fromArg = args.cli_path?.trim();
  if (fromArg) candidates.push(path.resolve(cwd, fromArg));

  const fromEnv = env.AGENTCOMPANY_CLI_PATH?.trim();
  if (fromEnv) candidates.push(path.resolve(cwd, fromEnv));

  candidates.push(path.join(cwd, "dist", "cli.js"));
  candidates.push(path.join(cwd, "..", "dist", "cli.js"));
  return Array.from(new Set(candidates));
}

async function resolveCliPath(
  args: DesktopDoctorArgs,
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<string | undefined> {
  const candidates = resolveCliCandidates(args, env, cwd);
  for (const c of candidates) {
    if (await pathExists(c)) return c;
  }
  return undefined;
}

export async function desktopDoctor(
  args: DesktopDoctorArgs,
  deps: DesktopDoctorDeps = {}
): Promise<DesktopDoctorResult> {
  const checks: DesktopDoctorCheck[] = [];
  const probe = deps.probe_command ?? defaultProbeCommand;
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;

  const runtimeNode = process.execPath;
  const runtimeNodeExec = await pathExecutable(runtimeNode);
  checks.push({
    id: "desktop.node_runtime",
    status: runtimeNodeExec ? "pass" : "fail",
    message: runtimeNodeExec
      ? `Node runtime detected at ${runtimeNode}`
      : `Node runtime is not executable: ${runtimeNode}`
  });

  const nodeBin = resolveNodeBin(args, env);
  if (isPathLike(nodeBin)) {
    const abs = path.resolve(cwd, nodeBin);
    const ok = await pathExecutable(abs);
    checks.push({
      id: "desktop.node_bin",
      status: ok ? "pass" : "fail",
      message: ok ? `Node binary is executable: ${abs}` : `Node binary is not executable: ${abs}`
    });
  } else {
    const res = await probe(nodeBin, ["--version"]);
    checks.push({
      id: "desktop.node_bin",
      status: res.ok ? "pass" : "fail",
      message: res.ok
        ? `Node binary is available on PATH (${nodeBin})`
        : `Node binary is not available on PATH (${nodeBin})`,
      details: [trimOutput(res.stdout), trimOutput(res.stderr), res.error ?? ""].filter(Boolean)
    });
  }

  const cliPath = await resolveCliPath(args, env, cwd);
  checks.push({
    id: "desktop.cli_bundle",
    status: cliPath ? "pass" : "fail",
    message: cliPath
      ? `CLI bundle found: ${cliPath}`
      : "Could not find dist/cli.js. Run `pnpm build` or set AGENTCOMPANY_CLI_PATH."
  });

  const tauri = await probe("pnpm", ["exec", "tauri", "--version"]);
  checks.push({
    id: "desktop.tauri_cli",
    status: tauri.ok ? "pass" : "fail",
    message: tauri.ok ? "Tauri CLI is available via pnpm." : "Tauri CLI is not available via pnpm.",
    details: [trimOutput(tauri.stdout), trimOutput(tauri.stderr), tauri.error ?? ""].filter(Boolean)
  });

  const rustc = await probe("rustc", ["--version"]);
  checks.push({
    id: "desktop.rustc",
    status: rustc.ok ? "pass" : "fail",
    message: rustc.ok ? "Rust compiler is available." : "Rust compiler (rustc) is missing.",
    details: [trimOutput(rustc.stdout), trimOutput(rustc.stderr), rustc.error ?? ""].filter(Boolean)
  });

  const cargo = await probe("cargo", ["--version"]);
  checks.push({
    id: "desktop.cargo",
    status: cargo.ok ? "pass" : "fail",
    message: cargo.ok ? "Cargo is available." : "Cargo is missing.",
    details: [trimOutput(cargo.stdout), trimOutput(cargo.stderr), cargo.error ?? ""].filter(Boolean)
  });

  const workspaceDir = args.workspace_dir?.trim();
  if (workspaceDir) {
    const absWorkspace = path.resolve(cwd, workspaceDir);
    const workspaceExists = await pathExists(absWorkspace);
    checks.push({
      id: "desktop.workspace",
      status: workspaceExists ? "pass" : "fail",
      message: workspaceExists
        ? `Workspace path exists: ${absWorkspace}`
        : `Workspace path does not exist: ${absWorkspace}`
    });

    if (workspaceExists) {
      const companyYaml = path.join(absWorkspace, "company", "company.yaml");
      const canonicalOk = await pathExists(companyYaml);
      checks.push({
        id: "desktop.workspace_layout",
        status: canonicalOk ? "pass" : "warn",
        message: canonicalOk
          ? "Workspace canonical company file exists."
          : "company/company.yaml not found in workspace path."
      });

      const projectId = args.project_id?.trim();
      if (projectId) {
        const projectYaml = path.join(absWorkspace, "work", "projects", projectId, "project.yaml");
        const projectExists = await pathExists(projectYaml);
        checks.push({
          id: "desktop.project",
          status: projectExists ? "pass" : "fail",
          message: projectExists
            ? `Project exists: ${projectId}`
            : `Project not found in workspace: ${projectId}`
        });
      }
    }
  } else if (args.project_id?.trim()) {
    checks.push({
      id: "desktop.project",
      status: "fail",
      message: "project_id was provided but workspace_dir is missing."
    });
  }

  const summary = checks.reduce(
    (acc, c) => {
      acc[c.status] += 1;
      return acc;
    },
    { pass: 0, warn: 0, fail: 0 } as { pass: number; warn: number; fail: number }
  );

  return {
    ok: summary.fail === 0,
    checks,
    summary,
    resolved: {
      cli_path: cliPath,
      node_bin: nodeBin
    }
  };
}

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { nowIso } from "../core/time.js";
import { readYamlFile, writeYamlFile } from "../store/yaml.js";
import { MachineYaml } from "../schemas/machine.js";
import { RunYaml } from "../schemas/run.js";
import { newEnvelope } from "./events.js";
import { createEventWriter } from "./event_writer.js";

export type ExecuteCommandArgs = {
  workspace_dir: string;
  project_id: string;
  run_id: string;
  argv: string[];
  repo_id?: string;
  workdir_rel?: string;
  env?: Record<string, string>;
};

export type ExecuteCommandResult = {
  exit_code: number | null;
  signal: string | null;
};

function resolveCwd(
  workspaceDir: string,
  repoRoots: Record<string, string>,
  repoId?: string,
  workdirRel?: string
): string {
  if (!repoId) return workspaceDir;
  const root = repoRoots[repoId];
  if (!root) {
    const known = Object.keys(repoRoots);
    const hint = known.length ? `Known repo_ids: ${known.join(", ")}` : "No repo_ids configured yet.";
    throw new Error(
      `Unknown repo_id "${repoId}". Configure it in .local/machine.yaml. ${hint}`
    );
  }
  return workdirRel ? path.join(root, workdirRel) : root;
}

export async function executeCommandRun(args: ExecuteCommandArgs): Promise<ExecuteCommandResult> {
  if (args.argv.length === 0) throw new Error("argv must be non-empty");

  const projectDir = path.join(args.workspace_dir, "work/projects", args.project_id);
  const runDir = path.join(projectDir, "runs", args.run_id);

  const runYamlPath = path.join(runDir, "run.yaml");
  const eventsPath = path.join(runDir, "events.jsonl");
  const machineYamlPath = path.join(args.workspace_dir, ".local/machine.yaml");

  const runDoc = RunYaml.parse(await readYamlFile(runYamlPath));
  const machineDoc = MachineYaml.parse(await readYamlFile(machineYamlPath));

  if (runDoc.status !== "running") {
    throw new Error(`Run is not in running status (status=${runDoc.status})`);
  }

  const cwd = resolveCwd(args.workspace_dir, machineDoc.repo_roots, args.repo_id, args.workdir_rel);
  const cwdStat = await fs.stat(cwd).catch(() => null);
  if (!cwdStat || !cwdStat.isDirectory()) {
    throw new Error(`Resolved cwd does not exist or is not a directory: ${cwd}`);
  }

  // Persist run spec for reproducibility.
  await writeYamlFile(runYamlPath, {
    ...runDoc,
    spec: {
      kind: "command",
      argv: args.argv,
      repo_id: args.repo_id,
      workdir_rel: args.workdir_rel,
      env: args.env
    }
  });

  const sessionRef = `local_${args.run_id}`;
  const writer = createEventWriter(eventsPath);

  writer.write(
    newEnvelope({
      schema_version: 1,
      ts_wallclock: nowIso(),
      run_id: args.run_id,
      session_ref: sessionRef,
      actor: "system",
      visibility: "org",
      type: "run.executing",
      payload: {
        argv: args.argv,
        repo_id: args.repo_id,
        workdir_rel: args.workdir_rel
      }
    })
  );

  const child = spawn(args.argv[0], args.argv.slice(1), {
    cwd,
    env: { ...process.env, ...(args.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout?.on("data", (buf: Buffer) => {
    writer.write(
      newEnvelope({
        schema_version: 1,
        ts_wallclock: nowIso(),
        run_id: args.run_id,
        session_ref: sessionRef,
        actor: runDoc.agent_id,
        visibility: "team",
        type: "provider.raw",
        payload: {
          stream: "stdout",
          chunk: buf.toString("utf8")
        }
      })
    );
  });

  child.stderr?.on("data", (buf: Buffer) => {
    writer.write(
      newEnvelope({
        schema_version: 1,
        ts_wallclock: nowIso(),
        run_id: args.run_id,
        session_ref: sessionRef,
        actor: runDoc.agent_id,
        visibility: "team",
        type: "provider.raw",
        payload: {
          stream: "stderr",
          chunk: buf.toString("utf8")
        }
      })
    );
  });

  const exitRes: ExecuteCommandResult = await new Promise((resolve, reject) => {
    child.on("error", (e) => reject(e));
    child.on("exit", (code, signal) => resolve({ exit_code: code, signal }));
  });

  const endedAt = nowIso();
  const ok = exitRes.exit_code === 0;

  writer.write(
    newEnvelope({
      schema_version: 1,
      ts_wallclock: endedAt,
      run_id: args.run_id,
      session_ref: sessionRef,
      actor: "system",
      visibility: "org",
      type: ok ? "run.ended" : "run.failed",
      payload: {
        exit_code: exitRes.exit_code,
        signal: exitRes.signal
      }
    })
  );

  await writer.flush();

  await writeYamlFile(runYamlPath, {
    ...runDoc,
    status: ok ? "ended" : "failed",
    spec: {
      kind: "command",
      argv: args.argv,
      repo_id: args.repo_id,
      workdir_rel: args.workdir_rel,
      env: args.env
    }
  });

  return exitRes;
}


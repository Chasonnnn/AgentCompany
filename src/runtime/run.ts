import path from "node:path";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { ensureDir } from "../store/fs.js";
import { writeYamlFile } from "../store/yaml.js";
import { ensureRunFiles, appendEventJsonl, newEnvelope } from "./events.js";

export type CreateRunArgs = {
  workspace_dir: string;
  project_id: string;
  agent_id: string;
  provider: string;
  session_ref?: string;
  actor?: string;
};

export async function createRun(args: CreateRunArgs): Promise<{
  run_id: string;
  context_pack_id: string;
  run_dir: string;
}> {
  const runId = newId("run");
  const ctxId = newId("ctx");
  const createdAt = nowIso();

  const projectDir = path.join(args.workspace_dir, "work/projects", args.project_id);
  const runDir = path.join(projectDir, "runs", runId);
  const outputsDir = path.join(runDir, "outputs");

  await ensureDir(runDir);
  await ensureDir(outputsDir);

  const eventsRel = path.join("runs", runId, "events.jsonl");
  const eventsAbs = path.join(projectDir, eventsRel);
  await ensureRunFiles(runDir);

  await writeYamlFile(path.join(runDir, "run.yaml"), {
    schema_version: 1,
    type: "run",
    id: runId,
    project_id: args.project_id,
    agent_id: args.agent_id,
    provider: args.provider,
    created_at: createdAt,
    status: "running",
    context_pack_id: ctxId,
    events_relpath: eventsRel
  });

  // Create Context Pack skeleton.
  const ctxDir = path.join(projectDir, "context_packs", ctxId);
  await ensureDir(ctxDir);
  await ensureDir(path.join(ctxDir, "bundle"));

  await writeYamlFile(path.join(ctxDir, "manifest.yaml"), {
    schema_version: 1,
    type: "context_pack_manifest",
    id: ctxId,
    created_at: createdAt,
    run_id: runId,
    project_id: args.project_id,
    agent_id: args.agent_id,
    included_docs: [],
    tool_allowlist: []
  });

  await writeYamlFile(path.join(ctxDir, "policy_snapshot.yaml"), {
    schema_version: 1,
    type: "policy_snapshot",
    id: newId("art"),
    created_at: createdAt,
    run_id: runId,
    tool_allowlist: []
  });

  // Emit initial started event.
  const ev = newEnvelope({
    schema_version: 1,
    ts_wallclock: createdAt,
    run_id: runId,
    session_ref: args.session_ref ?? `local_${runId}`,
    actor: args.actor ?? "system",
    visibility: "org",
    type: "run.started",
    payload: {
      project_id: args.project_id,
      agent_id: args.agent_id,
      provider: args.provider,
      context_pack_id: ctxId
    }
  });
  await appendEventJsonl(eventsAbs, ev);

  return { run_id: runId, context_pack_id: ctxId, run_dir: runDir };
}


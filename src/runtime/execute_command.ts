import fs from "node:fs/promises";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { nowIso } from "../core/time.js";
import { newId } from "../core/ids.js";
import { readYamlFile, writeYamlFile } from "../store/yaml.js";
import type { BudgetThreshold } from "../schemas/budget.js";
import { MachineYaml } from "../schemas/machine.js";
import { RunYaml } from "../schemas/run.js";
import { newEnvelope } from "./events.js";
import { createEventWriter } from "./event_writer.js";
import { ContextPackManifestYaml } from "../schemas/context_pack.js";
import { writeFileAtomic } from "../store/fs.js";
import { parseFrontMatter } from "../artifacts/frontmatter.js";
import { TaskFrontMatter } from "../work/task_markdown.js";
import { computeRunUsageCostUsd } from "./cost.js";
import { evaluateBudgetForCompletedRun } from "./budget.js";
import {
  extractUsageFromJsonLine,
  splitCompleteLines,
  estimateUsageFromChars,
  selectPreferredUsage,
  type RunUsageSummary
} from "./token_usage.js";

export type ExecuteCommandArgs = {
  workspace_dir: string;
  project_id: string;
  run_id: string;
  argv: string[];
  repo_id?: string;
  workdir_rel?: string;
  task_id?: string;
  milestone_id?: string;
  budget?: BudgetThreshold;
  env?: Record<string, string>;
  stdin_text?: string;
  session_ref?: string;
  on_child_spawn?: (args: { pid: number; stop_marker_relpath: string }) => void;
  abort_signal?: AbortSignal;
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

function defaultWorktreeBranch(projectId: string, taskId: string, runId: string): string {
  return `ac/${projectId}/${taskId}/${runId}`;
}

type ResolvedWorktree = {
  cwd: string;
  worktree_relpath?: string;
  worktree_branch?: string;
};

async function execText(cmd: string, args: string[], cwd: string): Promise<string> {
  const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  child.stdout?.on("data", (b: Buffer) => chunks.push(b));
  child.stderr?.on("data", (b: Buffer) => errChunks.push(b));
  const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.on("error", (e) => reject(e));
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  if (exit.code !== 0) {
    const stderr = Buffer.concat(errChunks).toString("utf8");
    throw new Error(`Command failed: ${cmd} ${args.join(" ")} (code=${exit.code}): ${stderr}`);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function resolveExecutionWorktree(args: {
  workspace_dir: string;
  project_id: string;
  run_id: string;
  repo_id?: string;
  workdir_rel?: string;
  task_id?: string;
  milestone_id?: string;
  repo_roots: Record<string, string>;
  event_writer: ReturnType<typeof createEventWriter>;
  session_ref: string;
  actor: string;
}): Promise<ResolvedWorktree> {
  const baseCwd = resolveCwd(args.workspace_dir, args.repo_roots, args.repo_id, args.workdir_rel);
  if (!args.repo_id || !args.task_id) {
    return { cwd: baseCwd };
  }

  const taskPath = path.join(
    args.workspace_dir,
    "work/projects",
    args.project_id,
    "tasks",
    `${args.task_id}.md`
  );
  const taskMd = await fs.readFile(taskPath, { encoding: "utf8" });
  const taskParsed = parseFrontMatter(taskMd);
  if (!taskParsed.ok) throw new Error(`Invalid task markdown: ${taskParsed.error}`);
  const taskFm = TaskFrontMatter.parse(taskParsed.frontmatter);

  let milestoneKind: string | undefined;
  if (args.milestone_id) {
    const ms = taskFm.milestones.find((m) => m.id === args.milestone_id);
    if (!ms) throw new Error(`Milestone not found in task ${args.task_id}: ${args.milestone_id}`);
    milestoneKind = ms.kind;
  }

  const scopeIsolation = taskFm.scope?.requires_worktree_isolation;
  const shouldIsolate =
    scopeIsolation === true || (scopeIsolation !== false && milestoneKind === "coding");
  if (!shouldIsolate) {
    return { cwd: baseCwd };
  }

  const repoRoot = args.repo_roots[args.repo_id];
  if (!repoRoot) {
    throw new Error(`Cannot prepare worktree: unknown repo_id "${args.repo_id}"`);
  }

  const worktreeRel = path.join(".local", "worktrees", args.project_id, args.task_id, args.run_id);
  const worktreeAbs = path.join(args.workspace_dir, worktreeRel);
  const branch = defaultWorktreeBranch(args.project_id, args.task_id, args.run_id);

  await fs.mkdir(path.dirname(worktreeAbs), { recursive: true });
  await execText("git", ["worktree", "add", "-b", branch, worktreeAbs, "HEAD"], repoRoot);

  args.event_writer.write(
    newEnvelope({
      schema_version: 1,
      ts_wallclock: nowIso(),
      run_id: args.run_id,
      session_ref: args.session_ref,
      actor: args.actor,
      visibility: "org",
      type: "worktree.prepared",
      payload: {
        repo_id: args.repo_id,
        task_id: args.task_id,
        milestone_id: args.milestone_id ?? null,
        worktree_relpath: worktreeRel,
        branch
      }
    })
  );

  const cwd = args.workdir_rel ? path.join(worktreeAbs, args.workdir_rel) : worktreeAbs;
  return {
    cwd,
    worktree_relpath: worktreeRel,
    worktree_branch: branch
  };
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

  // Always tee raw stdout/stderr to run outputs for debugging/replay.
  const outputsDir = path.join(runDir, "outputs");
  const stdoutPath = path.join(outputsDir, "stdout.txt");
  const stderrPath = path.join(outputsDir, "stderr.txt");
  const stdoutStream = createWriteStream(stdoutPath, { flags: "w" });
  const stderrStream = createWriteStream(stderrPath, { flags: "w" });

  // Persist run spec for reproducibility.
  const stdinRelpath =
    args.stdin_text === undefined ? undefined : path.join("runs", args.run_id, "outputs", "stdin.txt");
  if (args.stdin_text !== undefined) {
    await writeFileAtomic(path.join(outputsDir, "stdin.txt"), args.stdin_text);
  }
  const sessionRef = args.session_ref ?? `local_${args.run_id}`;
  const stopMarkerRelpath = path.join("runs", args.run_id, "outputs", "stop_requested.flag");
  const stopMarkerAbs = path.join(runDir, "outputs", "stop_requested.flag");
  const writer = createEventWriter(eventsPath);
  const worktree = await resolveExecutionWorktree({
    workspace_dir: args.workspace_dir,
    project_id: args.project_id,
    run_id: args.run_id,
    repo_id: args.repo_id,
    workdir_rel: args.workdir_rel,
    task_id: args.task_id,
    milestone_id: args.milestone_id,
    repo_roots: machineDoc.repo_roots,
    event_writer: writer,
    session_ref: sessionRef,
    actor: runDoc.agent_id
  });
  const cwd = worktree.cwd;
  const cwdStat = await fs.stat(cwd).catch(() => null);
  if (!cwdStat || !cwdStat.isDirectory()) {
    throw new Error(`Resolved cwd does not exist or is not a directory: ${cwd}`);
  }

  await writeYamlFile(runYamlPath, {
    ...runDoc,
    spec: {
      kind: "command",
      argv: args.argv,
      repo_id: args.repo_id,
      workdir_rel: args.workdir_rel,
      task_id: args.task_id,
      milestone_id: args.milestone_id,
      worktree_relpath: worktree.worktree_relpath,
      worktree_branch: worktree.worktree_branch,
      budget: args.budget,
      env: args.env,
      stdin_relpath: stdinRelpath
    }
  });

  // Best-effort: snapshot repo HEAD + dirty state into the Context Pack manifest.
  if (args.repo_id) {
    const repoRoot = machineDoc.repo_roots[args.repo_id];
    const ctxManifestPath = path.join(
      projectDir,
      "context_packs",
      runDoc.context_pack_id,
      "manifest.yaml"
    );
    try {
      const headSha = (await execText("git", ["rev-parse", "HEAD"], repoRoot)).trim();
      const statusPorcelain = await execText("git", ["status", "--porcelain=v1"], repoRoot);
      const dirty = statusPorcelain.trim().length > 0;
      let dirtyPatchArtifactId: string | undefined;

      if (dirty) {
        const patchText = await execText("git", ["diff", "HEAD"], repoRoot);
        if (patchText.trim().length > 0) {
          dirtyPatchArtifactId = newId("art");
          const patchRel = path.join(
            "work/projects",
            args.project_id,
            "artifacts",
            `${dirtyPatchArtifactId}.patch`
          );
          await writeFileAtomic(path.join(args.workspace_dir, patchRel), patchText);
          writer.write(
            newEnvelope({
              schema_version: 1,
              ts_wallclock: nowIso(),
              run_id: args.run_id,
              session_ref: sessionRef,
              actor: "system",
              visibility: "org",
              type: "artifact.produced",
              payload: {
                artifact_id: dirtyPatchArtifactId,
                relpath: patchRel,
                kind: "repo_dirty_patch",
                repo_id: args.repo_id
              }
            })
          );
        }
      }

      const manifest = ContextPackManifestYaml.parse(await readYamlFile(ctxManifestPath));
      await writeYamlFile(ctxManifestPath, {
        ...manifest,
        repo_snapshot: {
          repo_id: args.repo_id,
          head_sha: headSha,
          dirty,
          dirty_patch_artifact_id: dirtyPatchArtifactId
        }
      });

      writer.write(
        newEnvelope({
          schema_version: 1,
          ts_wallclock: nowIso(),
          run_id: args.run_id,
          session_ref: sessionRef,
          actor: "system",
          visibility: "org",
          type: "context_pack.snapshot_written",
          payload: {
            context_pack_id: runDoc.context_pack_id,
            repo_id: args.repo_id,
            head_sha: headSha,
            dirty,
            dirty_patch_artifact_id: dirtyPatchArtifactId ?? null
          }
        })
      );
    } catch (e) {
      writer.write(
        newEnvelope({
          schema_version: 1,
          ts_wallclock: nowIso(),
          run_id: args.run_id,
          session_ref: sessionRef,
          actor: "system",
          visibility: "org",
          type: "context_pack.snapshot_failed",
          payload: {
            context_pack_id: runDoc.context_pack_id,
            repo_id: args.repo_id,
            error: e instanceof Error ? e.message : String(e)
          }
        })
      );
    }
  }

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
        workdir_rel: args.workdir_rel,
        task_id: args.task_id ?? null,
        milestone_id: args.milestone_id ?? null,
        worktree_relpath: worktree.worktree_relpath ?? null,
        worktree_branch: worktree.worktree_branch ?? null,
        stdin_relpath: stdinRelpath ?? null
      }
    })
  );

  const child = spawn(args.argv[0], args.argv.slice(1), {
    cwd,
    env: { ...process.env, ...(args.env ?? {}) },
    stdio: [args.stdin_text === undefined ? "ignore" : "pipe", "pipe", "pipe"]
  });
  if (typeof child.pid === "number" && child.pid > 0) {
    args.on_child_spawn?.({
      pid: child.pid,
      stop_marker_relpath: stopMarkerRelpath
    });
  }

  const reportedUsageCandidates: RunUsageSummary[] = [];
  const seenUsageSignatures = new Set<string>();
  let stdoutUsageBuffer = "";
  let stderrUsageBuffer = "";
  let stdoutChars = 0;
  let stderrChars = 0;

  function recordUsage(u: RunUsageSummary): void {
    const sig = JSON.stringify({
      source: u.source,
      provider: u.provider ?? null,
      input_tokens: u.input_tokens ?? null,
      cached_input_tokens: u.cached_input_tokens ?? null,
      output_tokens: u.output_tokens ?? null,
      reasoning_output_tokens: u.reasoning_output_tokens ?? null,
      total_tokens: u.total_tokens
    });
    if (seenUsageSignatures.has(sig)) return;
    seenUsageSignatures.add(sig);
    reportedUsageCandidates.push(u);
    writer.write(
      newEnvelope({
        schema_version: 1,
        ts_wallclock: nowIso(),
        run_id: args.run_id,
        session_ref: sessionRef,
        actor: "system",
        visibility: "org",
        type: "usage.reported",
        payload: u
      })
    );
  }

  function parseUsageFromTextLines(text: string): void {
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    for (const line of lines) {
      for (const u of extractUsageFromJsonLine(line, runDoc.provider)) {
        recordUsage(u);
      }
    }
  }

  let stopRequested = false;
  const abortHandler = (): void => {
    stopRequested = true;
    void writeFileAtomic(stopMarkerAbs, nowIso()).catch(() => {});
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, 1500).unref();
  };
  if (args.abort_signal) {
    if (args.abort_signal.aborted) abortHandler();
    else args.abort_signal.addEventListener("abort", abortHandler, { once: true });
  }

  if (args.stdin_text !== undefined && child.stdin) {
    child.stdin.write(args.stdin_text, "utf8");
    child.stdin.end();
  }

  child.stdout?.on("data", (buf: Buffer) => {
    const text = buf.toString("utf8");
    stdoutChars += text.length;
    stdoutStream.write(buf);
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
          chunk: text
        }
      })
    );
    stdoutUsageBuffer += text;
    const parsed = splitCompleteLines(stdoutUsageBuffer);
    stdoutUsageBuffer = parsed.rest;
    for (const line of parsed.lines) {
      for (const u of extractUsageFromJsonLine(line, runDoc.provider)) {
        recordUsage(u);
      }
    }
  });

  child.stderr?.on("data", (buf: Buffer) => {
    const text = buf.toString("utf8");
    stderrChars += text.length;
    stderrStream.write(buf);
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
          chunk: text
        }
      })
    );
    stderrUsageBuffer += text;
    const parsed = splitCompleteLines(stderrUsageBuffer);
    stderrUsageBuffer = parsed.rest;
    for (const line of parsed.lines) {
      for (const u of extractUsageFromJsonLine(line, runDoc.provider)) {
        recordUsage(u);
      }
    }
  });

  const exitRes: ExecuteCommandResult = await new Promise((resolve, reject) => {
    child.on("error", async (e) => {
      try {
        stdoutStream.end();
        stderrStream.end();
      } finally {
        reject(e);
      }
    });
    // 'close' fires after stdio streams are drained.
    child.on("close", (code, signal) => resolve({ exit_code: code, signal }));
  });
  if (args.abort_signal) {
    args.abort_signal.removeEventListener("abort", abortHandler);
  }

  const endedAt = nowIso();
  const stopMarkerExists = await fs
    .access(stopMarkerAbs)
    .then(() => true)
    .catch(() => false);
  const stopped = stopRequested || stopMarkerExists;
  const ok = exitRes.exit_code === 0;

  // Flush any trailing partial lines for usage parsing.
  if (stdoutUsageBuffer.trim().length > 0) parseUsageFromTextLines(stdoutUsageBuffer);
  if (stderrUsageBuffer.trim().length > 0) parseUsageFromTextLines(stderrUsageBuffer);

  const usageBase =
    selectPreferredUsage(reportedUsageCandidates) ??
    estimateUsageFromChars({
      provider: runDoc.provider,
      stdin_chars: args.stdin_text?.length ?? 0,
      stdout_chars: stdoutChars,
      stderr_chars: stderrChars
    });
  const usageCost = computeRunUsageCostUsd({
    usage: usageBase,
    provider: runDoc.provider,
    machine: machineDoc
  });
  const finalUsage = {
    ...usageBase,
    cost_usd: usageCost.cost_usd ?? undefined,
    cost_currency: usageCost.cost_usd === null ? undefined : usageCost.currency,
    cost_source: usageCost.source,
    cost_rate_card_provider: usageCost.rate_card_provider
  };

  if (usageBase.source === "estimated_chars") {
    writer.write(
      newEnvelope({
        schema_version: 1,
        ts_wallclock: endedAt,
        run_id: args.run_id,
        session_ref: sessionRef,
        actor: "system",
        visibility: "org",
        type: "usage.estimated",
        payload: usageBase
      })
    );
  }
  if (usageCost.cost_usd !== null) {
    writer.write(
      newEnvelope({
        schema_version: 1,
        ts_wallclock: endedAt,
        run_id: args.run_id,
        session_ref: sessionRef,
        actor: "system",
        visibility: "org",
        type: "usage.cost_computed",
        payload: {
          cost_usd: usageCost.cost_usd,
          currency: usageCost.currency,
          source: usageCost.source,
          rate_card_provider: usageCost.rate_card_provider ?? null
        }
      })
    );
  }
  await writeFileAtomic(
    path.join(outputsDir, "token_usage.json"),
    `${JSON.stringify(finalUsage, null, 2)}\n`
  );

  const specDoc = {
    kind: "command" as const,
    argv: args.argv,
    repo_id: args.repo_id,
    workdir_rel: args.workdir_rel,
    task_id: args.task_id,
    milestone_id: args.milestone_id,
    worktree_relpath: worktree.worktree_relpath,
    worktree_branch: worktree.worktree_branch,
    budget: args.budget,
    env: args.env,
    stdin_relpath: stdinRelpath
  };
  const provisionalStatus = stopped ? "stopped" : ok ? "ended" : "failed";
  await writeYamlFile(runYamlPath, {
    ...runDoc,
    status: provisionalStatus,
    ended_at: endedAt,
    usage: finalUsage,
    spec: specDoc
  });

  const budgetEval = await evaluateBudgetForCompletedRun({
    workspace_dir: args.workspace_dir,
    project_id: args.project_id,
    run_id: args.run_id,
    task_id: args.task_id,
    run_budget: args.budget
  }).catch(() => ({ decisions: [], alerts: [], exceeded: [] }));

  for (const decision of budgetEval.decisions) {
    writer.write(
      newEnvelope({
        schema_version: 1,
        ts_wallclock: endedAt,
        run_id: args.run_id,
        session_ref: sessionRef,
        actor: "system",
        visibility: "org",
        type: "budget.decision",
        payload: decision
      })
    );
  }

  for (const finding of budgetEval.alerts) {
    writer.write(
      newEnvelope({
        schema_version: 1,
        ts_wallclock: endedAt,
        run_id: args.run_id,
        session_ref: sessionRef,
        actor: "system",
        visibility: "org",
        type: "budget.alert",
        payload: finding
      })
    );
  }
  for (const finding of budgetEval.exceeded) {
    writer.write(
      newEnvelope({
        schema_version: 1,
        ts_wallclock: endedAt,
        run_id: args.run_id,
        session_ref: sessionRef,
        actor: "system",
        visibility: "org",
        type: "budget.exceeded",
        payload: finding
      })
    );
  }

  const finalStatus =
    provisionalStatus === "ended" && budgetEval.exceeded.length > 0 ? "failed" : provisionalStatus;

  writer.write(
    newEnvelope({
      schema_version: 1,
      ts_wallclock: endedAt,
      run_id: args.run_id,
      session_ref: sessionRef,
      actor: "system",
      visibility: "org",
      type: finalStatus === "stopped" ? "run.stopped" : finalStatus === "ended" ? "run.ended" : "run.failed",
      payload: {
        exit_code: exitRes.exit_code,
        signal: exitRes.signal,
        stopped: finalStatus === "stopped",
        budget_exceeded: budgetEval.exceeded.length > 0
      }
    })
  );

  await writer.flush();

  await new Promise<void>((resolve) => stdoutStream.end(() => resolve()));
  await new Promise<void>((resolve) => stderrStream.end(() => resolve()));

  if (finalStatus !== provisionalStatus) {
    await writeYamlFile(runYamlPath, {
      ...runDoc,
      status: finalStatus,
      ended_at: endedAt,
      usage: finalUsage,
      spec: specDoc
    });
  }

  return exitRes;
}

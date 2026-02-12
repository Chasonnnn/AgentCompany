import fs from "node:fs/promises";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { nowIso } from "../core/time.js";
import { readYamlFile, writeYamlFile } from "../store/yaml.js";
import { MachineYaml } from "../schemas/machine.js";
import { RunYaml, type RunUsageSummary } from "../schemas/run.js";
import type { BudgetThreshold } from "../schemas/budget.js";
import { createEventWriter } from "./event_writer.js";
import { newEnvelope } from "./events.js";
import { writeFileAtomic } from "../store/fs.js";
import { estimateUsageFromChars, selectPreferredUsage, splitCompleteLines } from "./token_usage.js";
import { computeRunUsageCostUsd } from "./cost.js";
import { evaluateBudgetForCompletedRun } from "./budget.js";
import {
  detectContextCyclesFromProtocolNotification,
  summarizeContextCycleSignals,
  type ContextCycleSignal
} from "./context_cycles.js";

export type ExecuteCodexAppServerArgs = {
  workspace_dir: string;
  project_id: string;
  run_id: string;
  prompt_text: string;
  model?: string;
  repo_id?: string;
  workdir_rel?: string;
  task_id?: string;
  milestone_id?: string;
  budget?: BudgetThreshold;
  env?: Record<string, string>;
  session_ref?: string;
  on_state_update?: (state: {
    pid?: number;
    stop_marker_relpath?: string;
    thread_id?: string;
    turn_id?: string;
  }) => void;
  abort_signal?: AbortSignal;
};

export type ExecuteCodexAppServerResult = {
  exit_code: number | null;
  signal: string | null;
};

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (err: unknown) => void;
};

function asNonNegativeInt(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return undefined;
  return Math.floor(v);
}

function extractUsageFromProtocolNotification(
  value: unknown,
  provider: string
): RunUsageSummary | null {
  const obj = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  if (!obj) return null;
  const usageObjRaw =
    (typeof obj.last === "object" && obj.last !== null
      ? (obj.last as Record<string, unknown>)
      : undefined) ??
    (typeof obj.total === "object" && obj.total !== null
      ? (obj.total as Record<string, unknown>)
      : undefined) ??
    obj;

  const input = asNonNegativeInt(usageObjRaw.inputTokens);
  const cachedInput = asNonNegativeInt(usageObjRaw.cachedInputTokens);
  const output = asNonNegativeInt(usageObjRaw.outputTokens);
  const reasoning = asNonNegativeInt(usageObjRaw.reasoningOutputTokens);
  let total = asNonNegativeInt(usageObjRaw.totalTokens);
  if (total === undefined) {
    const subtotal = (input ?? 0) + (cachedInput ?? 0) + (output ?? 0) + (reasoning ?? 0);
    if (subtotal > 0) total = subtotal;
  }
  if (total === undefined) return null;
  return {
    source: "provider_reported",
    confidence: "high",
    provider,
    input_tokens: input,
    cached_input_tokens: cachedInput,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: total,
    captured_from_event_type: "thread/tokenUsage/updated"
  };
}

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
    throw new Error(`Unknown repo_id "${repoId}". ${hint}`);
  }
  return workdirRel ? path.join(root, workdirRel) : root;
}

export async function executeCodexAppServerRun(
  args: ExecuteCodexAppServerArgs
): Promise<ExecuteCodexAppServerResult> {
  if (!args.prompt_text.trim()) {
    throw new Error("prompt_text must be non-empty for codex_app_server runs");
  }

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

  const sessionRef = args.session_ref ?? `local_${args.run_id}`;
  const outputsDir = path.join(runDir, "outputs");
  const stdoutPath = path.join(outputsDir, "stdout.txt");
  const stderrPath = path.join(outputsDir, "stderr.txt");
  const promptRelpath = path.join("runs", args.run_id, "outputs", "prompt.txt");
  const stopMarkerRelpath = path.join("runs", args.run_id, "outputs", "stop_requested.flag");
  const stopMarkerAbs = path.join(outputsDir, "stop_requested.flag");
  const promptAbs = path.join(outputsDir, "prompt.txt");
  const lastMessageAbs = path.join(outputsDir, "last_message.md");
  await writeFileAtomic(promptAbs, args.prompt_text);

  const stdoutStream = createWriteStream(stdoutPath, { flags: "w" });
  const stderrStream = createWriteStream(stderrPath, { flags: "w" });
  const writer = createEventWriter(eventsPath);

  const providerBin =
    machineDoc.provider_bins.codex_app_server ??
    machineDoc.provider_bins.codex ??
    "codex";

  const cwd = resolveCwd(args.workspace_dir, machineDoc.repo_roots, args.repo_id, args.workdir_rel);
  const cwdStat = await fs.stat(cwd).catch(() => null);
  if (!cwdStat || !cwdStat.isDirectory()) {
    throw new Error(`Resolved cwd does not exist or is not a directory: ${cwd}`);
  }

  await writeYamlFile(runYamlPath, {
    ...runDoc,
    spec: {
      kind: "codex_app_server",
      prompt_relpath: promptRelpath,
      model: args.model,
      repo_id: args.repo_id,
      workdir_rel: args.workdir_rel,
      task_id: args.task_id,
      milestone_id: args.milestone_id,
      budget: args.budget
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
      type: "run.executing",
      payload: {
        mode: "codex_app_server",
        provider_bin: providerBin,
        prompt_relpath: promptRelpath,
        model: args.model ?? null,
        repo_id: args.repo_id ?? null,
        workdir_rel: args.workdir_rel ?? null,
        task_id: args.task_id ?? null,
        milestone_id: args.milestone_id ?? null
      }
    })
  );

  const child = spawn(providerBin, ["app-server"], {
    cwd,
    env: { ...process.env, ...(args.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"]
  });
  if (typeof child.pid === "number" && child.pid > 0) {
    args.on_state_update?.({ pid: child.pid, stop_marker_relpath: stopMarkerRelpath });
  }

  let stdoutBuffer = "";
  let stderrBuffer = "";
  let stdoutChars = 0;
  let stderrChars = 0;
  let stopRequested = false;
  let nextRequestId = 1;
  let threadId: string | undefined;
  let turnId: string | undefined;
  let assistantBuffer = "";
  let completionStatus: "completed" | "interrupted" | "failed" | undefined;
  let completionError: string | undefined;
  const pending = new Map<number, PendingRequest>();
  const reportedUsages: RunUsageSummary[] = [];
  const usageSigs = new Set<string>();
  const contextCycleSignals: ContextCycleSignal[] = [];
  const contextCycleSignalSeen = new Set<string>();

  let waitForTurnCompleteResolve: (() => void) | null = null;
  const waitForTurnComplete = new Promise<void>((resolve) => {
    waitForTurnCompleteResolve = resolve;
  });

  function sendProtocolMessage(msg: unknown): void {
    if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) return;
    child.stdin.write(`${JSON.stringify(msg)}\n`, "utf8");
  }

  function rejectAllPending(err: unknown): void {
    for (const req of pending.values()) {
      req.reject(err);
    }
    pending.clear();
  }

  function recordUsage(u: RunUsageSummary): void {
    const sig = JSON.stringify({
      input_tokens: u.input_tokens ?? null,
      cached_input_tokens: u.cached_input_tokens ?? null,
      output_tokens: u.output_tokens ?? null,
      reasoning_output_tokens: u.reasoning_output_tokens ?? null,
      total_tokens: u.total_tokens
    });
    if (usageSigs.has(sig)) return;
    usageSigs.add(sig);
    reportedUsages.push(u);
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

  function recordContextCycleSignals(signals: ContextCycleSignal[]): void {
    for (const signal of signals) {
      const sig = `${signal.source}::${signal.signal_type}::${signal.count}`;
      if (contextCycleSignalSeen.has(sig)) continue;
      contextCycleSignalSeen.add(sig);
      contextCycleSignals.push(signal);
      writer.write(
        newEnvelope({
          schema_version: 1,
          ts_wallclock: nowIso(),
          run_id: args.run_id,
          session_ref: sessionRef,
          actor: "system",
          visibility: "org",
          type: "context.cycle.detected",
          payload: signal
        })
      );
    }
  }

  function handleProtocolNotification(message: Record<string, unknown>): void {
    const method = typeof message.method === "string" ? message.method : "";
    const params =
      typeof message.params === "object" && message.params !== null
        ? (message.params as Record<string, unknown>)
        : {};

    recordContextCycleSignals(detectContextCyclesFromProtocolNotification(method, params));

    if (method === "item/agentMessage/delta") {
      const delta = typeof params.delta === "string" ? params.delta : "";
      assistantBuffer += delta;
    } else if (method === "thread/tokenUsage/updated") {
      const usage = extractUsageFromProtocolNotification(params.tokenUsage, runDoc.provider);
      if (usage) recordUsage(usage);
    } else if (method === "turn/completed") {
      const turn =
        typeof params.turn === "object" && params.turn !== null
          ? (params.turn as Record<string, unknown>)
          : {};
      const statusRaw = typeof turn.status === "string" ? turn.status : "";
      if (statusRaw === "completed" || statusRaw === "interrupted" || statusRaw === "failed") {
        completionStatus = statusRaw;
      } else {
        completionStatus = "failed";
      }
      const errObj =
        typeof turn.error === "object" && turn.error !== null
          ? (turn.error as Record<string, unknown>)
          : null;
      if (errObj && typeof errObj.message === "string") {
        completionError = errObj.message;
      }
      waitForTurnCompleteResolve?.();
    } else if (method === "error") {
      const err =
        typeof params.error === "object" && params.error !== null
          ? (params.error as Record<string, unknown>)
          : null;
      if (err && typeof err.message === "string") {
        completionError = err.message;
      }
    }
  }

  function handleProtocolLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const obj = msg as Record<string, unknown>;

    // JSON-RPC-like response.
    if ("id" in obj && (Object.hasOwn(obj, "result") || Object.hasOwn(obj, "error"))) {
      const id = typeof obj.id === "number" ? obj.id : Number.NaN;
      if (!Number.isFinite(id)) return;
      const req = pending.get(id);
      if (!req) return;
      pending.delete(id);
      if (Object.hasOwn(obj, "error")) {
        const errObj =
          typeof obj.error === "object" && obj.error !== null
            ? (obj.error as Record<string, unknown>)
            : {};
        const msg =
          typeof errObj.message === "string"
            ? errObj.message
            : JSON.stringify(errObj);
        req.reject(new Error(msg));
      } else {
        req.resolve(obj.result);
      }
      return;
    }

    // Server-initiated request (method + id). We reject unsupported methods explicitly.
    if (typeof obj.method === "string" && "id" in obj) {
      sendProtocolMessage({
        id: obj.id,
        error: { code: -32601, message: "Unsupported server request in AgentCompany v0" }
      });
      return;
    }

    if (typeof obj.method === "string") {
      handleProtocolNotification(obj);
    }
  }

  async function request(method: string, params: unknown): Promise<any> {
    const id = nextRequestId++;
    const p = new Promise<any>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    sendProtocolMessage({ id, method, params });
    return p;
  }

  const closePromise = new Promise<ExecuteCodexAppServerResult>((resolve, reject) => {
    child.on("error", (e) => reject(e));
    child.on("close", (code, signal) => {
      rejectAllPending(new Error("Codex app-server process exited before request completion"));
      resolve({ exit_code: code, signal });
    });
  });

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
    stdoutBuffer += text;
    const parsed = splitCompleteLines(stdoutBuffer);
    stdoutBuffer = parsed.rest;
    for (const line of parsed.lines) handleProtocolLine(line);
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
    stderrBuffer += text;
  });

  const abortHandler = (): void => {
    stopRequested = true;
    void writeFileAtomic(stopMarkerAbs, nowIso()).catch(() => {});
    if (threadId && turnId) {
      void request("turn/interrupt", { threadId, turnId }).catch(() => {
        // ignore and fallback to process signal below.
      });
    }
    setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // already exited
      }
    }, 100).unref();
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already exited
      }
    }, 1500).unref();
  };

  if (args.abort_signal) {
    if (args.abort_signal.aborted) abortHandler();
    else args.abort_signal.addEventListener("abort", abortHandler, { once: true });
  }

  let exitRes: ExecuteCodexAppServerResult = { exit_code: null, signal: null };
  try {
    await request("initialize", {
      clientInfo: { name: "agentcompany", version: "0.0.0" },
      capabilities: null
    });

    const threadStart = await request("thread/start", {
      model: args.model ?? null,
      cwd,
      experimentalRawEvents: true
    });
    threadId =
      typeof threadStart?.thread?.id === "string" ? threadStart.thread.id : undefined;
    args.on_state_update?.({ thread_id: threadId });

    const turnStart = await request("turn/start", {
      threadId,
      input: [{ type: "text", text: args.prompt_text, text_elements: [] }],
      ...(args.model ? { model: args.model } : {})
    });
    turnId = typeof turnStart?.turn?.id === "string" ? turnStart.turn.id : undefined;
    args.on_state_update?.({ turn_id: turnId });

    await writeYamlFile(runYamlPath, {
      ...runDoc,
      spec: {
        kind: "codex_app_server",
        prompt_relpath: promptRelpath,
        model: args.model,
        repo_id: args.repo_id,
        workdir_rel: args.workdir_rel,
        task_id: args.task_id,
        milestone_id: args.milestone_id,
        budget: args.budget,
        thread_id: threadId,
        turn_id: turnId
      }
    });

    await Promise.race([
      waitForTurnComplete,
      closePromise.then(() => undefined)
    ]);
  } finally {
    try {
      child.stdin?.end();
    } catch {
      // ignore
    }
    if (args.abort_signal) {
      args.abort_signal.removeEventListener("abort", abortHandler);
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    exitRes = await closePromise;
  }

  const endedAt = nowIso();
  const stopMarkerExists = await fs
    .access(stopMarkerAbs)
    .then(() => true)
    .catch(() => false);
  const stopped = stopRequested || stopMarkerExists || completionStatus === "interrupted";

  if (stdoutBuffer.trim().length > 0) handleProtocolLine(stdoutBuffer.trim());
  if (stderrBuffer.trim().length > 0) {
    // best effort: keep parity with stdout parser for any JSON lines emitted on stderr.
    for (const line of stderrBuffer.split("\n").map((l) => l.trim()).filter(Boolean)) {
      handleProtocolLine(line);
    }
  }

  const usageBase =
    selectPreferredUsage(reportedUsages) ??
    estimateUsageFromChars({
      provider: runDoc.provider,
      stdin_chars: args.prompt_text.length,
      stdout_chars: stdoutChars,
      stderr_chars: stderrChars
    });
  const usageCost = computeRunUsageCostUsd({
    usage: usageBase,
    provider: runDoc.provider,
    machine: machineDoc
  });
  const finalUsage: RunUsageSummary = {
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

  await writeFileAtomic(path.join(outputsDir, "token_usage.json"), `${JSON.stringify(finalUsage, null, 2)}\n`);
  await writeFileAtomic(lastMessageAbs, assistantBuffer);

  const provisionalStatus =
    stopped ? "stopped" : completionStatus === "completed" ? "ended" : "failed";
  const cycleSummary = summarizeContextCycleSignals(contextCycleSignals);
  const runContextCycles =
    cycleSummary.count > 0
      ? {
          count: cycleSummary.count,
          source: "provider_signal" as const,
          signal_types: cycleSummary.signal_types
        }
      : {
          count: 0,
          source: "unavailable" as const
        };

  await writeYamlFile(runYamlPath, {
    ...runDoc,
    status: provisionalStatus,
    ended_at: endedAt,
    usage: finalUsage,
    context_cycles: runContextCycles,
    spec: {
      kind: "codex_app_server",
      prompt_relpath: promptRelpath,
      model: args.model,
      repo_id: args.repo_id,
      workdir_rel: args.workdir_rel,
      task_id: args.task_id,
      milestone_id: args.milestone_id,
      budget: args.budget,
      thread_id: threadId,
      turn_id: turnId
    }
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
        exit_code: finalStatus === "ended" ? 0 : 1,
        signal: exitRes.signal,
        stopped: finalStatus === "stopped",
        budget_exceeded: budgetEval.exceeded.length > 0,
        completion_status: completionStatus ?? null,
        completion_error: completionError ?? null
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
      context_cycles: runContextCycles,
      spec: {
        kind: "codex_app_server",
        prompt_relpath: promptRelpath,
        model: args.model,
        repo_id: args.repo_id,
        workdir_rel: args.workdir_rel,
        task_id: args.task_id,
        milestone_id: args.milestone_id,
        budget: args.budget,
        thread_id: threadId,
        turn_id: turnId
      }
    });
  }

  return {
    exit_code: finalStatus === "ended" ? 0 : 1,
    signal: exitRes.signal
  };
}

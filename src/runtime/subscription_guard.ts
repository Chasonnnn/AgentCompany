import path from "node:path";
import { spawn } from "node:child_process";
import { nowIso } from "../core/time.js";
import { resolveProviderBin } from "../drivers/resolve_bin.js";
import { readMachineConfig } from "../machine/machine.js";
import { appendEventJsonl, newEnvelope } from "./events.js";
import type { ProviderExecutionPolicy } from "../schemas/machine.js";

type NormalizedPolicy = {
  provider_key: string;
  channel: "subscription_cli" | "api";
  require_subscription_proof: boolean;
  proof_strategy?: string;
  allowed_bin_patterns: string[];
};

export type SubscriptionCheckResult =
  | {
      ok: true;
      policy: NormalizedPolicy;
      resolved_bin: string;
      proof: {
        strategy: string;
        detail: string;
      };
    }
  | {
      ok: false;
      policy: NormalizedPolicy;
      resolved_bin: string;
      reason:
        | "subscription_unverified"
        | "unknown_proof_strategy"
        | "unapproved_worker_binary"
        | "api_key_present"
        | "auth_probe_failed";
      message: string;
    };

const DEFAULT_EXECUTION_POLICY: Record<string, ProviderExecutionPolicy> = {
  codex: {
    channel: "subscription_cli",
    require_subscription_proof: true,
    proof_strategy: "codex_cli",
    allowed_bin_patterns: ["codex"]
  },
  codex_app_server: {
    channel: "subscription_cli",
    require_subscription_proof: true,
    proof_strategy: "codex_cli",
    allowed_bin_patterns: ["codex"]
  },
  claude: {
    channel: "subscription_cli",
    require_subscription_proof: true,
    proof_strategy: "claude_cli",
    allowed_bin_patterns: ["claude"]
  },
  claude_code: {
    channel: "subscription_cli",
    require_subscription_proof: true,
    proof_strategy: "claude_cli",
    allowed_bin_patterns: ["claude"]
  },
  gemini: {
    channel: "api",
    require_subscription_proof: false,
    allowed_bin_patterns: ["gemini"]
  },
  manager: {
    channel: "api",
    require_subscription_proof: false,
    allowed_bin_patterns: []
  }
};

function providerAliasCandidates(provider: string): string[] {
  const p = provider.trim();
  if (!p) return [];
  const out = new Set<string>([p]);
  if (p === "codex-app-server") out.add("codex_app_server");
  if (p === "codex_app_server") out.add("codex");
  if (p === "claude-code") out.add("claude_code");
  if (p === "claude_code") out.add("claude");
  return [...out];
}

function resolveExecutionPolicy(args: {
  provider: string;
  machinePolicy?: Record<string, ProviderExecutionPolicy>;
}): NormalizedPolicy {
  const candidates = providerAliasCandidates(args.provider);
  for (const key of candidates) {
    const found = args.machinePolicy?.[key];
    if (found) {
      return {
        provider_key: key,
        channel: found.channel,
        require_subscription_proof: found.require_subscription_proof,
        proof_strategy: found.proof_strategy,
        allowed_bin_patterns: found.allowed_bin_patterns
      };
    }
  }
  for (const key of candidates) {
    const found = DEFAULT_EXECUTION_POLICY[key];
    if (found) {
      return {
        provider_key: key,
        channel: found.channel,
        require_subscription_proof: found.require_subscription_proof,
        proof_strategy: found.proof_strategy,
        allowed_bin_patterns: found.allowed_bin_patterns
      };
    }
  }
  return {
    provider_key: args.provider,
    channel: "api",
    require_subscription_proof: false,
    allowed_bin_patterns: []
  };
}

function binAllowedByPolicy(resolvedBin: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  const base = path.basename(resolvedBin).toLowerCase();
  const full = resolvedBin.toLowerCase();
  return patterns.some((pat) => {
    const p = pat.toLowerCase();
    return base === p || base.startsWith(`${p}-`) || full.includes(p);
  });
}

function envHasAny(keys: readonly string[], overrides?: Record<string, string>): string | null {
  for (const key of keys) {
    const v = overrides?.[key] ?? process.env[key];
    if (typeof v === "string" && v.trim().length > 0) return key;
  }
  return null;
}

function envValue(key: string, overrides?: Record<string, string>): string | undefined {
  const raw = overrides?.[key] ?? process.env[key];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed.length) return undefined;
  return trimmed;
}

function truthyEnvFlag(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function isGeminiProvider(provider: string): boolean {
  const p = provider.trim().toLowerCase();
  return p === "gemini" || p === "gemini_cli" || p.startsWith("gemini-");
}

function verifyApiChannelPrereq(args: {
  provider: string;
  effective_env?: Record<string, string>;
}):
  | { ok: true; detail: string }
  | { ok: false; reason: "auth_probe_failed"; detail: string } {
  if (!isGeminiProvider(args.provider)) {
    return { ok: true, detail: "provider channel is api" };
  }

  const geminiApiKey = envValue("GEMINI_API_KEY", args.effective_env);
  if (geminiApiKey) {
    return { ok: true, detail: "GEMINI_API_KEY detected for Gemini API auth" };
  }
  const googleApiKey = envValue("GOOGLE_API_KEY", args.effective_env);
  if (googleApiKey) {
    return { ok: true, detail: "GOOGLE_API_KEY detected for Gemini API auth" };
  }

  const useVertexAi = truthyEnvFlag(envValue("GOOGLE_GENAI_USE_VERTEXAI", args.effective_env));
  if (useVertexAi) {
    const project = envValue("GOOGLE_CLOUD_PROJECT", args.effective_env);
    const location = envValue("GOOGLE_CLOUD_LOCATION", args.effective_env);
    if (project && location) {
      return {
        ok: true,
        detail: "Vertex AI env detected (GOOGLE_GENAI_USE_VERTEXAI + GOOGLE_CLOUD_PROJECT + GOOGLE_CLOUD_LOCATION)"
      };
    }
    const missing: string[] = [];
    if (!project) missing.push("GOOGLE_CLOUD_PROJECT");
    if (!location) missing.push("GOOGLE_CLOUD_LOCATION");
    return {
      ok: false,
      reason: "auth_probe_failed",
      detail: `Gemini API channel requires Vertex AI project/location when GOOGLE_GENAI_USE_VERTEXAI is enabled. Missing: ${missing.join(", ")}`
    };
  }

  return {
    ok: false,
    reason: "auth_probe_failed",
    detail:
      "Gemini API credentials are missing. Set GEMINI_API_KEY, GOOGLE_API_KEY, or GOOGLE_GENAI_USE_VERTEXAI=true with GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION."
  };
}

async function runProbeCommand(args: {
  bin: string;
  argv: string[];
  timeout_ms?: number;
}): Promise<{ ok: boolean; stdout: string; stderr: string; exit_code: number | null }> {
  const timeoutMs = Math.max(500, args.timeout_ms ?? 4000);
  return await new Promise((resolve) => {
    const p = spawn(args.bin, args.argv, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        p.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve({
        ok: false,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        exit_code: null
      });
    }, timeoutMs);
    p.stdout?.on("data", (b: Buffer) => outChunks.push(b));
    p.stderr?.on("data", (b: Buffer) => errChunks.push(b));
    p.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        exit_code: null
      });
    });
    p.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        exit_code: code
      });
    });
  });
}

async function verifySubscriptionProof(args: {
  strategy: string | undefined;
  resolved_bin: string;
  effective_env?: Record<string, string>;
}): Promise<
  | { ok: true; detail: string }
  | {
      ok: false;
      reason: "unknown_proof_strategy" | "api_key_present" | "auth_probe_failed";
      detail: string;
    }
> {
  const strategy = args.strategy;
  switch (strategy) {
    case undefined:
      return { ok: false, reason: "unknown_proof_strategy", detail: "proof_strategy was not configured" };
    case "codex_cli": {
      const key = envHasAny(["OPENAI_API_KEY", "CODEX_API_KEY"], args.effective_env);
      if (key) return { ok: false, reason: "api_key_present", detail: `environment key present: ${key}` };
      const probe = await runProbeCommand({
        bin: args.resolved_bin,
        argv: ["login", "status"]
      });
      if (!probe.ok) {
        return {
          ok: false,
          reason: "auth_probe_failed",
          detail: `codex login status failed (exit=${probe.exit_code ?? "signal"}): ${probe.stderr.trim() || "no stderr"}`
        };
      }
      const text = `${probe.stdout}\n${probe.stderr}`.toLowerCase();
      if (text.includes("api key") || text.includes("apikey")) {
        return {
          ok: false,
          reason: "auth_probe_failed",
          detail: "codex login status indicates API-key auth mode"
        };
      }
      const hasSubscriptionIndicator = text.includes("chatgpt") || text.includes("logged in");
      if (!hasSubscriptionIndicator) {
        return {
          ok: false,
          reason: "auth_probe_failed",
          detail: "codex login status did not confirm a subscription login mode"
        };
      }
      return {
        ok: true,
        detail: "codex auth probe passed and no API-key mode was detected"
      };
    }
    case "claude_cli": {
      const key = envHasAny(["ANTHROPIC_API_KEY"], args.effective_env);
      if (key) return { ok: false, reason: "api_key_present", detail: `environment key present: ${key}` };
      return {
        ok: true,
        detail: "no ANTHROPIC_API_KEY detected; using CLI-managed auth path"
      };
    }
    case "gemini_cli": {
      const key = envHasAny(
        ["GOOGLE_API_KEY", "GEMINI_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI"],
        args.effective_env
      );
      if (key) return { ok: false, reason: "api_key_present", detail: `environment key present: ${key}` };
      return {
        ok: true,
        detail: "no Gemini API key/Vertex env detected; using CLI-managed auth path"
      };
    }
    default:
      return { ok: false, reason: "unknown_proof_strategy", detail: `unknown proof_strategy: ${strategy}` };
  }
}

async function appendSubscriptionEvent(args: {
  events_file_path?: string;
  run_id?: string;
  session_ref?: string;
  type: "worker.subscription_check.passed" | "worker.subscription_check.failed";
  payload: Record<string, unknown>;
}): Promise<void> {
  if (!args.events_file_path || !args.run_id || !args.session_ref) return;
  await appendEventJsonl(
    args.events_file_path,
    newEnvelope({
      schema_version: 1,
      ts_wallclock: nowIso(),
      run_id: args.run_id,
      session_ref: args.session_ref,
      actor: "system",
      visibility: "managers",
      type: args.type,
      payload: args.payload
    })
  ).catch(() => {});
}

export async function enforceSubscriptionExecutionPolicy(args: {
  workspace_dir: string;
  provider: string;
  events_file_path?: string;
  run_id?: string;
  session_ref?: string;
  effective_env?: Record<string, string>;
}): Promise<SubscriptionCheckResult> {
  const machine = await readMachineConfig(args.workspace_dir);
  const policy = resolveExecutionPolicy({
    provider: args.provider,
    machinePolicy: machine.provider_execution_policy
  });
  const resolved = await resolveProviderBin(args.workspace_dir, args.provider);

  if (!binAllowedByPolicy(resolved.bin, policy.allowed_bin_patterns)) {
    const out: SubscriptionCheckResult = {
      ok: false,
      policy,
      resolved_bin: resolved.bin,
      reason: "unapproved_worker_binary",
      message: `Resolved CLI binary is not allowed by policy: ${resolved.bin}`
    };
    await appendSubscriptionEvent({
      events_file_path: args.events_file_path,
      run_id: args.run_id,
      session_ref: args.session_ref,
      type: "worker.subscription_check.failed",
      payload: {
        provider: args.provider,
        policy,
        resolved_bin: resolved.bin,
        reason: out.reason,
        message: out.message
      }
    });
    return out;
  }

  if (policy.channel === "api") {
    const apiProof = verifyApiChannelPrereq({
      provider: args.provider,
      effective_env: args.effective_env
    });
    if (!apiProof.ok) {
      const out: SubscriptionCheckResult = {
        ok: false,
        policy,
        resolved_bin: resolved.bin,
        reason: apiProof.reason,
        message: apiProof.detail
      };
      await appendSubscriptionEvent({
        events_file_path: args.events_file_path,
        run_id: args.run_id,
        session_ref: args.session_ref,
        type: "worker.subscription_check.failed",
        payload: {
          provider: args.provider,
          policy,
          resolved_bin: resolved.bin,
          reason: out.reason,
          message: out.message
        }
      });
      return out;
    }
    const res: SubscriptionCheckResult = {
      ok: true,
      policy,
      resolved_bin: resolved.bin,
      proof: {
        strategy: "api_channel",
        detail: apiProof.detail
      }
    };
    await appendSubscriptionEvent({
      events_file_path: args.events_file_path,
      run_id: args.run_id,
      session_ref: args.session_ref,
      type: "worker.subscription_check.passed",
      payload: {
        provider: args.provider,
        policy,
        resolved_bin: resolved.bin,
        proof: res.proof
      }
    });
    return res;
  }

  if (!policy.require_subscription_proof) {
    const out: SubscriptionCheckResult = {
      ok: true,
      policy,
      resolved_bin: resolved.bin,
      proof: {
        strategy: policy.proof_strategy ?? "none",
        detail: "subscription proof not required by policy"
      }
    };
    await appendSubscriptionEvent({
      events_file_path: args.events_file_path,
      run_id: args.run_id,
      session_ref: args.session_ref,
      type: "worker.subscription_check.passed",
      payload: {
        provider: args.provider,
        policy,
        resolved_bin: resolved.bin,
        proof: out.proof
      }
    });
    return out;
  }

  const proof = await verifySubscriptionProof({
    strategy: policy.proof_strategy,
    resolved_bin: resolved.bin,
    effective_env: args.effective_env
  });
  if (!proof.ok) {
    const out: SubscriptionCheckResult = {
      ok: false,
      policy,
      resolved_bin: resolved.bin,
      reason:
        proof.reason === "api_key_present"
          ? "api_key_present"
          : proof.reason === "auth_probe_failed"
            ? "auth_probe_failed"
            : "unknown_proof_strategy",
      message: proof.detail
    };
    await appendSubscriptionEvent({
      events_file_path: args.events_file_path,
      run_id: args.run_id,
      session_ref: args.session_ref,
      type: "worker.subscription_check.failed",
      payload: {
        provider: args.provider,
        policy,
        resolved_bin: resolved.bin,
        reason: out.reason,
        message: out.message
      }
    });
    return out;
  }

  const out: SubscriptionCheckResult = {
    ok: true,
    policy,
    resolved_bin: resolved.bin,
    proof: {
      strategy: policy.proof_strategy ?? "unknown",
      detail: proof.detail
    }
  };
  await appendSubscriptionEvent({
    events_file_path: args.events_file_path,
    run_id: args.run_id,
    session_ref: args.session_ref,
    type: "worker.subscription_check.passed",
    payload: {
      provider: args.provider,
      policy,
      resolved_bin: resolved.bin,
      proof: out.proof
    }
  });
  return out;
}

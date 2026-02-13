import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { resolveProviderBin } from "../drivers/resolve_bin.js";
import { codexCliAdapterStatus } from "./codex_cli.js";
import { codexAppServerAdapterStatus } from "./codex_app_server.js";
import { claudeCliAdapterStatus } from "./claude_cli.js";
import { geminiCliAdapterStatus } from "./gemini_cli.js";
import type { AdapterStatus } from "./types.js";

async function isExecutableAvailable(bin: string): Promise<boolean> {
  if (!bin.trim()) return false;
  if (bin.startsWith("/") || bin.startsWith("./") || bin.startsWith("../")) {
    try {
      await fs.access(bin, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  return await new Promise<boolean>((resolve) => {
    const p = spawn("which", [bin], { stdio: ["ignore", "ignore", "ignore"] });
    p.on("error", () => resolve(false));
    p.on("exit", (code) => resolve(code === 0));
  });
}

async function supportsCodexAppServer(bin: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const p = spawn(bin, ["app-server", "--help"], {
      stdio: ["ignore", "ignore", "ignore"]
    });
    const timer = setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve(false);
    }, 4000);
    p.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    p.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

const OFFICIAL_CLI_ALLOWLIST: Record<string, string[]> = {
  codex: ["codex"],
  codex_app_server: ["codex"],
  claude: ["claude"],
  claude_code: ["claude"],
  gemini: ["gemini"]
};

function isOfficialProviderCliBin(provider: string, bin: string): boolean {
  const allowed = OFFICIAL_CLI_ALLOWLIST[provider] ?? OFFICIAL_CLI_ALLOWLIST[provider.replaceAll("-", "_")];
  if (!allowed?.length) return false;
  const base = path.basename(bin).toLowerCase();
  return allowed.some((name) => base === name || base.startsWith(`${name}-`));
}

function officialBinReason(provider: string, bin: string): string {
  const allow = OFFICIAL_CLI_ALLOWLIST[provider] ?? OFFICIAL_CLI_ALLOWLIST[provider.replaceAll("-", "_")] ?? [];
  return `Unapproved CLI binary for provider "${provider}": ${bin}. Allowed base names: ${allow.join(", ")}`;
}

export async function listAdapterStatuses(workspaceDir: string): Promise<AdapterStatus[]> {
  const codexResolved = await resolveProviderBin(workspaceDir, "codex");
  const codexAppResolved = await resolveProviderBin(workspaceDir, "codex_app_server");
  const claudeResolved = await resolveProviderBin(workspaceDir, "claude");
  const geminiResolved = await resolveProviderBin(workspaceDir, "gemini");
  const codexBinOk = isOfficialProviderCliBin("codex", codexResolved.bin);
  const codexCliAvailable = codexBinOk && (await isExecutableAvailable(codexResolved.bin));
  const codexAppBinOk = isOfficialProviderCliBin("codex_app_server", codexAppResolved.bin);
  const codexAppBinAvailable = codexAppBinOk && (await isExecutableAvailable(codexAppResolved.bin));
  const codexAppServerAvailable =
    codexAppBinAvailable && (await supportsCodexAppServer(codexAppResolved.bin));
  const claudeBinOk = isOfficialProviderCliBin("claude", claudeResolved.bin);
  const claudeCliAvailable = claudeBinOk && (await isExecutableAvailable(claudeResolved.bin));
  const geminiBinOk = isOfficialProviderCliBin("gemini", geminiResolved.bin);
  const geminiCliAvailable = geminiBinOk && (await isExecutableAvailable(geminiResolved.bin));

  const codexCli = codexCliAdapterStatus(
    codexCliAvailable,
    codexCliAvailable
      ? undefined
      : codexBinOk
        ? `codex binary not found: ${codexResolved.bin}`
        : officialBinReason("codex", codexResolved.bin)
  );
  const claudeCli = claudeCliAdapterStatus(
    claudeCliAvailable,
    claudeCliAvailable
      ? undefined
      : claudeBinOk
        ? `claude binary not found: ${claudeResolved.bin}`
        : officialBinReason("claude", claudeResolved.bin)
  );
  const geminiCli = geminiCliAdapterStatus(
    geminiCliAvailable,
    geminiCliAvailable
      ? undefined
      : geminiBinOk
        ? `gemini binary not found: ${geminiResolved.bin}`
        : officialBinReason("gemini", geminiResolved.bin)
  );

  const codexAppServer = codexAppServerAdapterStatus(
    codexAppServerAvailable,
    codexAppServerAvailable
      ? undefined
      : codexAppBinOk
        ? codexAppBinAvailable
          ? `codex app-server command unavailable for binary: ${codexAppResolved.bin}`
          : `codex binary not found: ${codexAppResolved.bin}`
        : officialBinReason("codex_app_server", codexAppResolved.bin)
  );

  return [codexAppServer, codexCli, claudeCli, geminiCli];
}

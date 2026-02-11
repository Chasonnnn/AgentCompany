import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolveProviderBin } from "../drivers/resolve_bin.js";
import { codexCliAdapterStatus } from "./codex_cli.js";
import { codexAppServerAdapterStatus } from "./codex_app_server.js";
import { claudeCliAdapterStatus } from "./claude_cli.js";
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

export async function listAdapterStatuses(workspaceDir: string): Promise<AdapterStatus[]> {
  const codexResolved = await resolveProviderBin(workspaceDir, "codex");
  const codexAppResolved = await resolveProviderBin(workspaceDir, "codex_app_server");
  const claudeResolved = await resolveProviderBin(workspaceDir, "claude");
  const codexCliAvailable = await isExecutableAvailable(codexResolved.bin);
  const codexAppBinAvailable = await isExecutableAvailable(codexAppResolved.bin);
  const codexAppServerAvailable =
    codexAppBinAvailable && (await supportsCodexAppServer(codexAppResolved.bin));
  const claudeCliAvailable = await isExecutableAvailable(claudeResolved.bin);

  const codexCli = codexCliAdapterStatus(
    codexCliAvailable,
    codexCliAvailable ? undefined : `codex binary not found: ${codexResolved.bin}`
  );
  const claudeCli = claudeCliAdapterStatus(
    claudeCliAvailable,
    claudeCliAvailable ? undefined : `claude binary not found: ${claudeResolved.bin}`
  );

  const codexAppServer = codexAppServerAdapterStatus(
    codexAppServerAvailable,
    codexAppServerAvailable
      ? undefined
      : codexAppBinAvailable
        ? `codex app-server command unavailable for binary: ${codexAppResolved.bin}`
        : `codex binary not found: ${codexAppResolved.bin}`
  );

  return [codexAppServer, codexCli, claudeCli];
}

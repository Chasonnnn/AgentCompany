import fs from "node:fs/promises";
import path from "node:path";

export type DesktopReleaseCheckStatus = "pass" | "warn" | "fail";

export type DesktopReleaseCheck = {
  id: string;
  status: DesktopReleaseCheckStatus;
  message: string;
  details?: string[];
};

export type DesktopReleaseDoctorResult = {
  ok: boolean;
  checks: DesktopReleaseCheck[];
  summary: {
    pass: number;
    warn: number;
    fail: number;
  };
  resolved: {
    tauri_config?: string;
    channels_config?: string;
  };
};

export type DesktopReleaseDoctorArgs = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function trim(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function looksLikeSemver(v: string): boolean {
  return /^\d+\.\d+\.\d+([\-+][0-9A-Za-z.\-]+)?$/.test(v);
}

async function pathExists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}

export async function desktopReleaseDoctor(
  args: DesktopReleaseDoctorArgs = {}
): Promise<DesktopReleaseDoctorResult> {
  const cwd = args.cwd ?? process.cwd();
  const env = args.env ?? process.env;
  const checks: DesktopReleaseCheck[] = [];

  const tauriConfigPath = path.join(cwd, "src-tauri", "tauri.conf.json");
  const channelsPath = path.join(cwd, "src-tauri", "release-channels.json");
  let tauriConfig: Record<string, unknown> | null = null;

  if (!(await pathExists(tauriConfigPath))) {
    checks.push({
      id: "release.tauri_config",
      status: "fail",
      message: `Missing Tauri config: ${tauriConfigPath}`
    });
  } else {
    try {
      const raw = JSON.parse(await fs.readFile(tauriConfigPath, { encoding: "utf8" })) as unknown;
      if (!isRecord(raw)) throw new Error("tauri.conf.json must be a JSON object");
      tauriConfig = raw;
      checks.push({
        id: "release.tauri_config",
        status: "pass",
        message: `Loaded Tauri config: ${tauriConfigPath}`
      });
    } catch (e) {
      checks.push({
        id: "release.tauri_config",
        status: "fail",
        message: `Failed to parse Tauri config: ${e instanceof Error ? e.message : String(e)}`
      });
    }
  }

  if (tauriConfig) {
    const identifier = trim(tauriConfig.identifier);
    checks.push({
      id: "release.identifier",
      status: identifier ? "pass" : "fail",
      message: identifier
        ? `Desktop identifier is set: ${identifier}`
        : "Desktop identifier is missing in tauri.conf.json"
    });

    const version = trim(tauriConfig.version);
    let versionStatus: DesktopReleaseCheckStatus = "pass";
    let versionMsg = `Desktop version is release-like: ${version}`;
    if (!version) {
      versionStatus = "fail";
      versionMsg = "Desktop version is missing in tauri.conf.json";
    } else if (version === "0.0.0" || !looksLikeSemver(version)) {
      versionStatus = "warn";
      versionMsg = `Desktop version is not release-ready: ${version}`;
    }
    checks.push({
      id: "release.version",
      status: versionStatus,
      message: versionMsg
    });

    const bundle = isRecord(tauriConfig.bundle) ? tauriConfig.bundle : {};
    const bundleActive = bundle.active === true;
    checks.push({
      id: "release.bundle_active",
      status: bundleActive ? "pass" : "warn",
      message: bundleActive
        ? "Tauri bundle.active is enabled."
        : "Tauri bundle.active is disabled (set true for packaged desktop releases)."
    });

    const plugins = isRecord(tauriConfig.plugins) ? tauriConfig.plugins : {};
    const updater = isRecord(plugins.updater) ? plugins.updater : {};
    const updaterActive = updater.active === true;
    const updaterPubkey = trim(updater.pubkey);
    const endpoints = Array.isArray(updater.endpoints)
      ? updater.endpoints.filter((e) => typeof e === "string" && e.trim().length > 0)
      : [];
    checks.push({
      id: "release.updater",
      status: updaterActive && updaterPubkey && endpoints.length > 0 ? "pass" : "warn",
      message:
        updaterActive && updaterPubkey && endpoints.length > 0
          ? `Updater configured (${endpoints.length} endpoint(s)).`
          : "Updater config incomplete (expected plugins.updater.active, pubkey, endpoints).",
      details: endpoints.length > 0 ? endpoints : undefined
    });

    const signingKey = trim(env.TAURI_SIGNING_PRIVATE_KEY);
    checks.push({
      id: "release.signing_key",
      status: signingKey ? "pass" : "warn",
      message: signingKey
        ? "TAURI_SIGNING_PRIVATE_KEY is set."
        : "TAURI_SIGNING_PRIVATE_KEY is missing (required for updater signatures)."
    });
  }

  if (!(await pathExists(channelsPath))) {
    checks.push({
      id: "release.channels",
      status: "warn",
      message: `Missing release channel strategy file: ${channelsPath}`
    });
  } else {
    try {
      const raw = JSON.parse(await fs.readFile(channelsPath, { encoding: "utf8" })) as unknown;
      if (!isRecord(raw)) throw new Error("release-channels.json must be a JSON object");
      const channels = ["alpha", "beta", "stable"];
      const missing: string[] = [];
      for (const ch of channels) {
        const row = isRecord(raw[ch]) ? raw[ch] : null;
        const endpoint = row ? trim(row.endpoint) : "";
        if (!endpoint) missing.push(ch);
      }
      checks.push({
        id: "release.channels",
        status: missing.length === 0 ? "pass" : "warn",
        message:
          missing.length === 0
            ? "Release channel strategy includes alpha/beta/stable endpoints."
            : `Release channels missing endpoints: ${missing.join(", ")}`
      });
    } catch (e) {
      checks.push({
        id: "release.channels",
        status: "fail",
        message: `Failed to parse release-channels.json: ${e instanceof Error ? e.message : String(e)}`
      });
    }
  }

  if (process.platform === "darwin") {
    const appleIdentity = trim(env.APPLE_SIGNING_IDENTITY);
    const appleTeamId = trim(env.APPLE_TEAM_ID);
    checks.push({
      id: "release.macos_signing",
      status: appleIdentity && appleTeamId ? "pass" : "warn",
      message:
        appleIdentity && appleTeamId
          ? "macOS signing identity and team id are set."
          : "APPLE_SIGNING_IDENTITY/APPLE_TEAM_ID missing (required for signed/notarized macOS releases)."
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
      tauri_config: (await pathExists(tauriConfigPath)) ? tauriConfigPath : undefined,
      channels_config: (await pathExists(channelsPath)) ? channelsPath : undefined
    }
  };
}

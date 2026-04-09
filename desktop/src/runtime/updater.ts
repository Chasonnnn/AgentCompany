import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from "electron";
import { dialog } from "electron";
import { MacUpdater, type UpdateCheckResult, type UpdateDownloadedEvent, type UpdateInfo } from "electron-updater";
import type { DesktopBuildMetadata } from "./build-metadata.js";
import type { DesktopLogger } from "./desktop-log.js";

const AUTO_CHECK_DELAY_MS = 30_000;
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

type CheckMode = "automatic" | "manual";

type DialogLike = {
  showMessageBox(
    browserWindowOrOptions: BrowserWindow | MessageBoxOptions,
    maybeOptions?: MessageBoxOptions,
  ): Promise<MessageBoxReturnValue>;
};

type UpdaterLike = {
  checkForUpdates(): Promise<UpdateCheckResult | null>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  autoDownload: boolean;
  logger?: unknown;
  on(event: "checking-for-update", listener: () => void): unknown;
  on(event: "update-available", listener: (info: UpdateInfo) => void): unknown;
  on(event: "update-not-available", listener: (info: UpdateInfo) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "download-progress", listener: (progress: { percent?: number }) => void): unknown;
  on(event: "update-downloaded", listener: (event: UpdateDownloadedEvent) => void): unknown;
};

type DesktopUpdaterState = {
  enabled: boolean;
  checking: boolean;
  downloading: boolean;
  downloadedVersion: string | null;
  downloadProgressPercent: number | null;
};

type TimerApi = {
  setTimeout(handler: () => void, timeoutMs: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(handler: () => void, timeoutMs: number): unknown;
  clearInterval(handle: unknown): void;
};

export type DesktopUpdaterHandle = {
  start(): void;
  dispose(): void;
  performMenuAction(): Promise<void>;
  getMenuState(): {
    enabled: boolean;
    label: string;
  };
};

export function createGenericMacUpdater(feedUrl: string): UpdaterLike {
  return new MacUpdater({
    provider: "generic",
    url: feedUrl,
  });
}

export function getDesktopUpdaterMenuLabel(input: {
  enabled: boolean;
  downloadedVersion: string | null;
}): string {
  if (!input.enabled) return "Check for Updates…";
  return input.downloadedVersion ? "Install Update and Restart…" : "Check for Updates…";
}

export function createDesktopUpdater(input: {
  metadata: DesktopBuildMetadata | null;
  log: DesktopLogger;
  getWindow(): BrowserWindow | null;
  stopForInstall(): Promise<void>;
  onStateChanged?(): void;
  dialogApi?: DialogLike;
  timers?: TimerApi;
  createUpdater?: (feedUrl: string) => UpdaterLike;
}): DesktopUpdaterHandle {
  const dialogApi = input.dialogApi ?? dialog;
  const timers = input.timers ?? {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  const createUpdater = input.createUpdater ?? createGenericMacUpdater;

  const state: DesktopUpdaterState = {
    enabled: Boolean(input.metadata?.feedUrl),
    checking: false,
    downloading: false,
    downloadedVersion: null,
    downloadProgressPercent: null,
  };

  let currentCheckMode: CheckMode | null = null;
  let updater: UpdaterLike | null = null;
  let delayedCheckTimer: unknown = null;
  let repeatingCheckTimer: unknown = null;
  let installingUpdate = false;

  const notifyStateChanged = () => {
    input.onStateChanged?.();
  };

  const getMenuState = () => ({
    enabled: state.enabled,
    label: getDesktopUpdaterMenuLabel({
      enabled: state.enabled,
      downloadedVersion: state.downloadedVersion,
    }),
  });

  const showMessage = async (options: MessageBoxOptions) => {
    const window = input.getWindow();
    if (window) {
      return dialogApi.showMessageBox(window, options);
    }
    return dialogApi.showMessageBox(options);
  };

  const showManualError = async (error: Error) => {
    await showMessage({
      type: "error",
      title: "Update Check Failed",
      message: "Paperclip could not check for updates.",
      detail: `${error.message}\n\nDesktop log: ${input.log.logPath}`,
      buttons: ["OK"],
    });
  };

  const installDownloadedUpdate = async () => {
    if (!updater || !state.downloadedVersion || installingUpdate) return;
    installingUpdate = true;
    input.log.info(`Installing desktop update ${state.downloadedVersion}`);
    await input.stopForInstall();
    updater.quitAndInstall(false, true);
  };

  const promptToInstallDownloadedUpdate = async () => {
    const version = state.downloadedVersion;
    if (!version) return;
    const result = await showMessage({
      type: "info",
      title: "Update Ready",
      message: `Paperclip ${version} is ready to install.`,
      detail: "Restart the app now to finish installing the downloaded update.",
      buttons: ["Restart and Install", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (result.response === 0) {
      await installDownloadedUpdate();
    }
  };

  const checkForUpdates = async (mode: CheckMode) => {
    if (!updater || !state.enabled) {
      if (mode === "manual") {
        await showMessage({
          type: "info",
          title: "Updates Unavailable",
          message: "Automatic updates are only enabled in CI-built desktop releases.",
          buttons: ["OK"],
        });
      }
      return;
    }

    if (state.downloadedVersion) {
      if (mode === "manual") {
        await promptToInstallDownloadedUpdate();
      }
      return;
    }

    if (state.checking) {
      if (mode === "manual") {
        await showMessage({
          type: "info",
          title: "Checking for Updates",
          message: "Paperclip is already checking for updates.",
          buttons: ["OK"],
        });
      }
      return;
    }

    if (state.downloading) {
      if (mode === "manual") {
        const detail = state.downloadProgressPercent != null
          ? `Current download progress: ${Math.round(state.downloadProgressPercent)}%.`
          : "An update is downloading in the background.";
        await showMessage({
          type: "info",
          title: "Downloading Update",
          message: "Paperclip is downloading an update.",
          detail,
          buttons: ["OK"],
        });
      }
      return;
    }

    currentCheckMode = mode;
    input.log.info(`Checking for desktop updates (${mode})`);
    await updater.checkForUpdates();
  };

  const start = () => {
    if (!input.metadata?.feedUrl) {
      input.log.info("Desktop updater disabled because no feed URL is configured.");
      notifyStateChanged();
      return;
    }

    updater = createUpdater(input.metadata.feedUrl);
    updater.autoDownload = true;
    updater.logger = {
      info: (message: string) => input.log.info(message),
      warn: (message: string) => input.log.warn(message),
      error: (message: string) => input.log.error(message),
    };

    updater.on("checking-for-update", () => {
      state.checking = true;
      state.downloadProgressPercent = null;
      notifyStateChanged();
    });

    updater.on("update-available", (info) => {
      state.checking = false;
      state.downloading = true;
      state.downloadedVersion = null;
      state.downloadProgressPercent = 0;
      input.log.info(`Desktop update available: ${info.version}`);
      notifyStateChanged();
    });

    updater.on("update-not-available", async (info) => {
      state.checking = false;
      state.downloading = false;
      state.downloadProgressPercent = null;
      input.log.info(`No desktop update available (current channel ${input.metadata?.channel ?? "unknown"}, latest ${info.version}).`);
      const previousMode = currentCheckMode;
      currentCheckMode = null;
      notifyStateChanged();
      if (previousMode === "manual") {
        await showMessage({
          type: "info",
          title: "Paperclip Is Up to Date",
          message: `You already have the latest desktop build (${input.metadata?.version ?? info.version}).`,
          buttons: ["OK"],
        });
      }
    });

    updater.on("download-progress", (progress) => {
      state.downloading = true;
      state.downloadProgressPercent = typeof progress.percent === "number" ? progress.percent : null;
      notifyStateChanged();
    });

    updater.on("update-downloaded", async (event) => {
      state.checking = false;
      state.downloading = false;
      state.downloadProgressPercent = 100;
      state.downloadedVersion = event.version;
      currentCheckMode = null;
      input.log.info(`Desktop update downloaded: ${event.version}`);
      notifyStateChanged();
      await promptToInstallDownloadedUpdate();
    });

    updater.on("error", async (error) => {
      state.checking = false;
      state.downloading = false;
      state.downloadProgressPercent = null;
      input.log.error(`Desktop updater error: ${error.message}`);
      const previousMode = currentCheckMode;
      currentCheckMode = null;
      notifyStateChanged();
      if (previousMode === "manual") {
        await showManualError(error);
      }
    });

    notifyStateChanged();
    delayedCheckTimer = timers.setTimeout(() => {
      void checkForUpdates("automatic");
      repeatingCheckTimer = timers.setInterval(() => {
        void checkForUpdates("automatic");
      }, AUTO_CHECK_INTERVAL_MS);
    }, AUTO_CHECK_DELAY_MS);
  };

  const dispose = () => {
    if (delayedCheckTimer) {
      timers.clearTimeout(delayedCheckTimer);
      delayedCheckTimer = null;
    }
    if (repeatingCheckTimer) {
      timers.clearInterval(repeatingCheckTimer);
      repeatingCheckTimer = null;
    }
  };

  return {
    start,
    dispose,
    performMenuAction: () => checkForUpdates("manual"),
    getMenuState,
  };
}

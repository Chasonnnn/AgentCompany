import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test } from "vitest";
import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from "electron";
import type { UpdateCheckResult } from "electron-updater";
import {
  createDesktopUpdater,
  getDesktopUpdaterMenuLabel,
} from "../runtime/updater.js";

class FakeUpdater extends EventEmitter {
  autoDownload = false;
  logger: unknown;
  checkCalls = 0;
  quitAndInstallCalls = 0;

  async checkForUpdates(): Promise<UpdateCheckResult | null> {
    this.checkCalls += 1;
    return null;
  }

  quitAndInstall() {
    this.quitAndInstallCalls += 1;
  }
}

function createFakeTimers() {
  const timeouts: Array<() => void> = [];
  const intervals: Array<() => void> = [];

  return {
    api: {
      setTimeout(handler: () => void, _timeoutMs: number) {
        timeouts.push(handler);
        return handler;
      },
      clearTimeout() {},
      setInterval(handler: () => void, _timeoutMs: number) {
        intervals.push(handler);
        return handler;
      },
      clearInterval() {},
    },
    runTimeout(index = 0) {
      timeouts[index]?.();
    },
    getIntervalCount() {
      return intervals.length;
    },
  };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  // no-op placeholder for symmetry if future tests add globals
});

describe("updater", () => {
  test("disables updater menu actions when no feed URL is bundled", () => {
    const handle = createDesktopUpdater({
      metadata: {
        channel: "local",
        feedUrl: null,
        commitSha: null,
        builtAt: "2026-04-08T22:00:00.000Z",
        version: "0.3.1",
      },
      log: {
        logPath: "/tmp/desktop.log",
        info() {},
        warn() {},
        error() {},
      },
      getWindow: () => null,
      stopForInstall: async () => {},
    });

    handle.start();
    expect(handle.getMenuState()).toEqual({
      enabled: false,
      label: "Check for Updates…",
    });
  });

  test("shows a native success dialog for manual checks when no update is available", async () => {
    const updater = new FakeUpdater();
    const dialogs: string[] = [];

    updater.checkForUpdates = async () => {
      updater.checkCalls += 1;
      updater.emit("checking-for-update");
      updater.emit("update-not-available", { version: "0.3.1-main.482" });
      return null;
    };

    const handle = createDesktopUpdater({
      metadata: {
        channel: "main",
        feedUrl: "https://example.com/desktop/latest/macos/arm64",
        commitSha: "abc123",
        builtAt: "2026-04-08T22:00:00.000Z",
        version: "0.3.1-main.482",
      },
      log: {
        logPath: "/tmp/desktop.log",
        info() {},
        warn() {},
        error() {},
      },
      getWindow: () => null,
      stopForInstall: async () => {},
      createUpdater: () => updater,
      dialogApi: {
        async showMessageBox(
          browserWindowOrOptions: BrowserWindow | MessageBoxOptions,
          maybeOptions?: MessageBoxOptions,
        ): Promise<MessageBoxReturnValue> {
          const options = (maybeOptions ?? browserWindowOrOptions) as { message?: string };
          dialogs.push(options.message ?? "");
          return { response: 0, checkboxChecked: false };
        },
      },
    });

    handle.start();
    await handle.performMenuAction();
    await flushAsyncWork();

    expect(updater.checkCalls).toBe(1);
    expect(dialogs).toContain("You already have the latest desktop build (0.3.1-main.482).");
  });

  test("keeps a downloaded update pending and installs it from the menu action", async () => {
    const updater = new FakeUpdater();
    const dialogs: string[] = [];
    const timers = createFakeTimers();
    let stopCalls = 0;
    let nextResponse = 1;

    const handle = createDesktopUpdater({
      metadata: {
        channel: "main",
        feedUrl: "https://example.com/desktop/latest/macos/arm64",
        commitSha: "abc123",
        builtAt: "2026-04-08T22:00:00.000Z",
        version: "0.3.1-main.482",
      },
      log: {
        logPath: "/tmp/desktop.log",
        info() {},
        warn() {},
        error() {},
      },
      getWindow: () => null,
      stopForInstall: async () => {
        stopCalls += 1;
      },
      createUpdater: () => updater,
      dialogApi: {
        async showMessageBox(
          browserWindowOrOptions: BrowserWindow | MessageBoxOptions,
          maybeOptions?: MessageBoxOptions,
        ): Promise<MessageBoxReturnValue> {
          const options = (maybeOptions ?? browserWindowOrOptions) as { message?: string };
          dialogs.push(options.message ?? "");
          return { response: nextResponse, checkboxChecked: false };
        },
      },
      timers: timers.api,
    });

    handle.start();
    timers.runTimeout();
    expect(timers.getIntervalCount()).toBe(1);

    updater.emit("update-downloaded", { version: "0.3.1-main.483" });
    await flushAsyncWork();

    expect(handle.getMenuState().label).toBe("Install Update and Restart…");
    expect(getDesktopUpdaterMenuLabel({ enabled: true, downloadedVersion: "0.3.1-main.483" }))
      .toBe("Install Update and Restart…");

    nextResponse = 0;
    await handle.performMenuAction();
    await flushAsyncWork();

    expect(dialogs).toContain("Paperclip 0.3.1-main.483 is ready to install.");
    expect(stopCalls).toBe(1);
    expect(updater.quitAndInstallCalls).toBe(1);
  });

  test("shows a manual error dialog when update checks fail", async () => {
    const updater = new FakeUpdater();
    const dialogs: string[] = [];

    updater.checkForUpdates = async () => {
      updater.checkCalls += 1;
      updater.emit("checking-for-update");
      updater.emit("error", new Error("feed unavailable"));
      return null;
    };

    const handle = createDesktopUpdater({
      metadata: {
        channel: "main",
        feedUrl: "https://example.com/desktop/latest/macos/arm64",
        commitSha: "abc123",
        builtAt: "2026-04-08T22:00:00.000Z",
        version: "0.3.1-main.482",
      },
      log: {
        logPath: "/tmp/desktop.log",
        info() {},
        warn() {},
        error() {},
      },
      getWindow: () => null,
      stopForInstall: async () => {},
      createUpdater: () => updater,
      dialogApi: {
        async showMessageBox(
          browserWindowOrOptions: BrowserWindow | MessageBoxOptions,
          maybeOptions?: MessageBoxOptions,
        ): Promise<MessageBoxReturnValue> {
          const options = (maybeOptions ?? browserWindowOrOptions) as { message?: string };
          dialogs.push(options.message ?? "");
          return { response: 0, checkboxChecked: false };
        },
      },
    });

    handle.start();
    await handle.performMenuAction();
    await flushAsyncWork();

    expect(updater.checkCalls).toBe(1);
    expect(dialogs).toContain("Paperclip could not check for updates.");
  });
});

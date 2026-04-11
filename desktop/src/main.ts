import { app, BrowserWindow, Menu, dialog, ipcMain, shell, type OpenDialogOptions } from "electron";
import path from "node:path";
import { existsSync } from "node:fs";
import {
  formatExitReason,
  resolveDesktopPaperclipHome,
  resolveDesktopServerLogPath,
  resolveDesktopServerRoot,
  startManagedServer,
  type ManagedServerHandle,
} from "./runtime/server-runtime.js";
import {
  loadDesktopBuildMetadata,
  resolveDesktopBuildMetadataPath,
  type DesktopBuildMetadata,
} from "./runtime/build-metadata.js";
import {
  createDesktopLogger,
  resolveDesktopLogPath,
  type DesktopLogger,
} from "./runtime/desktop-log.js";
import { attachRendererDiagnostics } from "./runtime/renderer-diagnostics.js";
import {
  createDesktopUpdater,
  type DesktopUpdaterHandle,
} from "./runtime/updater.js";
import {
  DEFAULT_WINDOW_STATE,
  loadWindowState,
  saveWindowState,
  type SavedWindowState,
} from "./runtime/window-state.js";
import { createApplicationMenuTemplate, readChosenDirectory } from "./runtime/application-menu.js";
import { renderSplashHtml, renderStartupErrorHtml, toDataUrl } from "./window-html.js";

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let serverHandle: ManagedServerHandle | null = null;
let desktopLogger: DesktopLogger | null = null;
let desktopUpdater: DesktopUpdaterHandle | null = null;
let buildMetadata: DesktopBuildMetadata | null = null;
let isQuitting = false;
let updaterStarted = false;

function resolveDesktopDevUrl(): string | null {
  const raw = process.env.PAPERCLIP_DESKTOP_DEV_URL?.trim();
  if (raw) return raw;
  if (!app.isPackaged) {
    return `http://127.0.0.1:${process.env.PORT ?? "3100"}`;
  }
  return null;
}

function getPreloadPath(): string {
  return path.resolve(__dirname, "preload.js");
}

function getDesktopLogPath(): string {
  return resolveDesktopLogPath(app.getPath("userData"));
}

function getBuildMetadata(): DesktopBuildMetadata | null {
  if (buildMetadata) return buildMetadata;
  buildMetadata = loadDesktopBuildMetadata(resolveDesktopBuildMetadataPath(path.resolve(__dirname, "..")));
  return buildMetadata;
}

function getWindowStatePath(): string {
  return path.resolve(app.getPath("userData"), "window-state.json");
}

function getWindowState(): SavedWindowState {
  const filePath = getWindowStatePath();
  return existsSync(filePath) ? loadWindowState(filePath) : DEFAULT_WINDOW_STATE;
}

function persistWindowState(window: BrowserWindow) {
  if (window.isDestroyed()) return;
  saveWindowState(getWindowStatePath(), {
    bounds: window.getBounds(),
    isMaximized: window.isMaximized(),
  });
}

function registerWindowStatePersistence(window: BrowserWindow) {
  let saveTimer: NodeJS.Timeout | null = null;
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      persistWindowState(window);
    }, 150);
  };

  window.on("resize", scheduleSave);
  window.on("move", scheduleSave);
  window.on("maximize", scheduleSave);
  window.on("unmaximize", scheduleSave);
  window.on("close", () => {
    if (saveTimer) clearTimeout(saveTimer);
    persistWindowState(window);
  });
}

function createBaseWindow(input: {
  width: number;
  height: number;
  show: boolean;
  title: string;
}) {
  return new BrowserWindow({
    width: input.width,
    height: input.height,
    show: input.show,
    title: input.title,
    backgroundColor: "#f8fafc",
    autoHideMenuBar: true,
    titleBarStyle: "default",
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
}

async function createSplashWindow() {
  splashWindow = createBaseWindow({
    width: 560,
    height: 420,
    show: true,
    title: "Paperclip",
  });
  splashWindow.setResizable(false);
  splashWindow.setMinimizable(false);
  splashWindow.setMaximizable(false);
  if (desktopLogger) {
    attachRendererDiagnostics({
      label: "splash",
      window: splashWindow,
      log: desktopLogger,
    });
  }
  await splashWindow.loadURL(toDataUrl(renderSplashHtml()));
  splashWindow.on("closed", () => {
    splashWindow = null;
  });
}

function isSameOriginUrl(rawUrl: string, allowedOrigin: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.origin === allowedOrigin;
  } catch {
    return false;
  }
}

function wireExternalNavigation(window: BrowserWindow, baseUrl: string) {
  const allowedOrigin = new URL(baseUrl).origin;
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!isSameOriginUrl(url, allowedOrigin)) {
      void shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isSameOriginUrl(url, allowedOrigin)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
}

async function createMainWindow(baseUrl: string) {
  const state = getWindowState();
  mainWindow = new BrowserWindow({
    ...state.bounds,
    show: false,
    title: "Paperclip",
    backgroundColor: "#f8fafc",
    autoHideMenuBar: true,
    titleBarStyle: "default",
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  if (state.isMaximized) {
    mainWindow.maximize();
  }
  registerWindowStatePersistence(mainWindow);
  wireExternalNavigation(mainWindow, baseUrl);
  if (desktopLogger) {
    attachRendererDiagnostics({
      label: "main",
      window: mainWindow,
      log: desktopLogger,
    });
  }
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    splashWindow?.close();
    if (!updaterStarted) {
      desktopUpdater?.start();
      updaterStarted = true;
    }
  });
  await mainWindow.loadURL(baseUrl);
}

function rebuildApplicationMenu() {
  const updateMenuState = desktopUpdater?.getMenuState() ?? {
    enabled: false,
    label: "Check for Updates…",
  };
  const template = createApplicationMenuTemplate({
    appName: app.name,
    platform: process.platform,
    updateMenuState,
    onCheckForUpdates: () => {
      void desktopUpdater?.performMenuAction();
    },
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function showStartupError(reason: string, logLines: string[]) {
  if (!splashWindow || splashWindow.isDestroyed()) {
    await createSplashWindow();
  }
  await splashWindow?.loadURL(
    toDataUrl(
      renderStartupErrorHtml({
        reason,
        logLines,
      }),
    ),
  );
}

function getLogsPathForActions(): string {
  const serverLogPath = serverHandle?.serverLogPath
    ?? resolveDesktopServerLogPath(resolveDesktopPaperclipHome(app.getPath("userData")));
  if (existsSync(serverLogPath)) return serverLogPath;
  return getDesktopLogPath();
}

function getPaperclipHomeForActions(): string {
  return serverHandle?.paperclipHome ?? resolveDesktopPaperclipHome(app.getPath("userData"));
}

async function openLogs() {
  const target = getLogsPathForActions();
  if (existsSync(target)) {
    shell.showItemInFolder(target);
    return;
  }
  await shell.openPath(path.dirname(target));
}

async function openDataFolder() {
  await shell.openPath(getPaperclipHomeForActions());
}

async function chooseDirectory(): Promise<string | null> {
  const options: OpenDialogOptions = {
    properties: ["openDirectory", "createDirectory"],
  };
  const ownerWindow = mainWindow ?? splashWindow;
  const result = ownerWindow
    ? await dialog.showOpenDialog(ownerWindow, options)
    : await dialog.showOpenDialog(options);
  return readChosenDirectory(result);
}

async function revealPath(targetPath: string) {
  const normalized = targetPath.trim();
  if (!normalized) return;
  shell.showItemInFolder(path.resolve(normalized));
}

async function bootPackagedRuntime() {
  await createSplashWindow();

  try {
    desktopLogger?.info("Booting packaged Paperclip desktop runtime.");
    serverHandle = await startManagedServer({
      userDataPath: app.getPath("userData"),
      serverRoot: resolveDesktopServerRoot({
        isPackaged: app.isPackaged,
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath,
      }),
    });
    void serverHandle.whenExit.then(async (exitInfo) => {
      if (isQuitting) return;
      const logLines = serverHandle?.getRecentLogLines() ?? [];
      desktopLogger?.error(`Managed server exited unexpectedly (${formatExitReason(exitInfo)}).`);
      await showStartupError(
        `The local Paperclip server stopped unexpectedly (${formatExitReason(exitInfo)}).`,
        logLines,
      );
      mainWindow?.close();
      mainWindow = null;
    });
    await createMainWindow(serverHandle.apiUrl);
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const [reason, logTail] = rawMessage.split("\n\nRecent server logs:\n");
    const logLines = logTail ? logTail.split("\n").filter(Boolean) : serverHandle?.getRecentLogLines() ?? [];
    desktopLogger?.error(`Desktop startup failed: ${reason}`);
    await showStartupError(reason, logLines);
  }
}

async function bootDesktopShell() {
  const devUrl = resolveDesktopDevUrl();
  if (devUrl) {
    await createMainWindow(devUrl);
    return;
  }
  await bootPackagedRuntime();
}

async function stopManagedServerIfNeeded() {
  const handle = serverHandle;
  serverHandle = null;
  if (handle) {
    await handle.stop();
  }
}

function focusPrimaryWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    return;
  }
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.focus();
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    focusPrimaryWindow();
  });
}

app.on("window-all-closed", () => {
  app.quit();
});

app.once("before-quit", () => {
  isQuitting = true;
});

app.whenReady().then(async () => {
  desktopLogger = createDesktopLogger(getDesktopLogPath());
  const metadata = getBuildMetadata();
  if (metadata) {
    desktopLogger.info(`Desktop build ${metadata.version} (${metadata.channel}) loaded.`);
  } else {
    desktopLogger.warn("Desktop build metadata not found; updater disabled.");
  }
  desktopUpdater = createDesktopUpdater({
    metadata,
    log: desktopLogger,
    getWindow: () => mainWindow,
    stopForInstall: async () => {
      isQuitting = true;
      await stopManagedServerIfNeeded();
    },
    onStateChanged: rebuildApplicationMenu,
  });
  rebuildApplicationMenu();

  ipcMain.handle("paperclip-desktop:open-logs", async () => {
    await openLogs();
  });
  ipcMain.handle("paperclip-desktop:open-data-folder", async () => {
    await openDataFolder();
  });
  ipcMain.handle("paperclip-desktop:reload-app", async () => {
    app.relaunch();
    app.quit();
  });
  ipcMain.handle("paperclip-desktop:choose-directory", async () => {
    return chooseDirectory();
  });
  ipcMain.handle("paperclip-desktop:reveal-path", async (_event, targetPath: string) => {
    await revealPath(targetPath);
  });

  await bootDesktopShell();
}).catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  app.exit(1);
});

app.on("will-quit", (event) => {
  desktopUpdater?.dispose();
  if (!serverHandle) return;
  event.preventDefault();
  void stopManagedServerIfNeeded().finally(() => {
    app.exit(0);
  });
});

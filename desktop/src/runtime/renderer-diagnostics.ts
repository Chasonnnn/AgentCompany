import type { DesktopLogger } from "./desktop-log.js";

type RendererDiagnosticsWindow = {
  webContents: {
    getURL(): string;
    on(
      event: "console-message",
      listener: (
        event: unknown,
        level: number,
        message: string,
        line: number,
        sourceId: string,
      ) => void,
    ): void;
    on(
      event: "render-process-gone",
      listener: (
        event: unknown,
        details: {
          reason: string;
          exitCode: number;
        },
      ) => void,
    ): void;
  };
};

function currentUrl(window: RendererDiagnosticsWindow): string {
  try {
    return window.webContents.getURL() || "about:blank";
  } catch {
    return "unknown";
  }
}

export function attachRendererDiagnostics(input: {
  label: string;
  window: RendererDiagnosticsWindow;
  log: DesktopLogger;
}) {
  const { label, window, log } = input;

  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level <= 0) return;
    const entry = `[renderer:${label}] console level=${level} url=${currentUrl(window)} source=${sourceId}:${line} message=${message}`;
    if (level >= 2) {
      log.error(entry);
      return;
    }
    log.warn(entry);
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    log.error(
      `[renderer:${label}] process-gone url=${currentUrl(window)} reason=${details.reason} exitCode=${details.exitCode}`,
    );
  });
}

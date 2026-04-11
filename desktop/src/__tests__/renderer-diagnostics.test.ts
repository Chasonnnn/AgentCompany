import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { DesktopLogger } from "../runtime/desktop-log.js";
import { attachRendererDiagnostics } from "../runtime/renderer-diagnostics.js";

class FakeWebContents extends EventEmitter {
  constructor(private readonly url: string) {
    super();
  }

  getURL() {
    return this.url;
  }
}

function createLogger(): DesktopLogger {
  return {
    logPath: "/tmp/desktop.log",
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("attachRendererDiagnostics", () => {
  it("writes renderer warnings and errors to the desktop log", () => {
    const log = createLogger();
    const webContents = new FakeWebContents("http://127.0.0.1:3100/issues/AIWA-7");

    attachRendererDiagnostics({
      label: "main",
      window: { webContents },
      log,
    });

    webContents.emit("console-message", {}, 1, "warn message", 42, "IssueDetail.tsx");
    webContents.emit("console-message", {}, 2, "error message", 57, "IssueChatThread.tsx");
    webContents.emit("console-message", {}, 0, "info message", 11, "ignored.ts");

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("[renderer:main] console level=1"),
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("url=http://127.0.0.1:3100/issues/AIWA-7"),
    );
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("[renderer:main] console level=2"),
    );
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("source=IssueChatThread.tsx:57"),
    );
    expect(log.info).not.toHaveBeenCalled();
  });

  it("logs render-process-gone events with route context", () => {
    const log = createLogger();
    const webContents = new FakeWebContents("http://127.0.0.1:3100/issues/AIWA-7");

    attachRendererDiagnostics({
      label: "main",
      window: { webContents },
      log,
    });

    webContents.emit("render-process-gone", {}, {
      reason: "crashed",
      exitCode: 9,
    });

    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("[renderer:main] process-gone"),
    );
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("reason=crashed exitCode=9"),
    );
  });
});

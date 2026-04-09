import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export type DesktopLogger = {
  logPath: string;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

function writeLine(logPath: string, level: string, message: string) {
  mkdirSync(path.dirname(logPath), { recursive: true });
  appendFileSync(logPath, `[${new Date().toISOString()}] ${level} ${message}\n`);
}

export function resolveDesktopLogPath(userDataPath: string): string {
  return path.resolve(userDataPath, "desktop.log");
}

export function createDesktopLogger(logPath: string): DesktopLogger {
  return {
    logPath,
    info: (message) => writeLine(logPath, "INFO", message),
    warn: (message) => writeLine(logPath, "WARN", message),
    error: (message) => writeLine(logPath, "ERROR", message),
  };
}

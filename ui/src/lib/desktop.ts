export interface PaperclipDesktopBridge {
  openLogs?: () => Promise<void>;
  openDataFolder?: () => Promise<void>;
  reloadApp?: () => Promise<void>;
  chooseDirectory?: () => Promise<string | null>;
  revealPath?: (targetPath: string) => Promise<void>;
}

export function getPaperclipDesktopBridge(): PaperclipDesktopBridge | null {
  if (typeof window === "undefined") return null;
  return window.paperclipDesktop ?? null;
}

export function canChooseDesktopDirectory() {
  return typeof getPaperclipDesktopBridge()?.chooseDirectory === "function";
}

export function canRevealDesktopPath() {
  return typeof getPaperclipDesktopBridge()?.revealPath === "function";
}

export function isAbsolutePath(value: string) {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

export function isRevealableDesktopPath(value: string | null | undefined) {
  if (!value) return false;
  const normalized = value.trim();
  if (!normalized) return false;
  return normalized.startsWith("/");
}

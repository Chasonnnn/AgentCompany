/// <reference types="vite/client" />

import type { PaperclipDesktopBridge } from "./lib/desktop";

declare global {
  interface Window {
    paperclipDesktop?: PaperclipDesktopBridge;
  }
}

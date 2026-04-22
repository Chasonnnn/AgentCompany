/// <reference types="vite/client" />

import type { PaperclipDesktopBridge } from "./lib/desktop";

declare global {
  interface ImportMetaEnv {
    readonly VITE_FEEDBACK_TERMS_URL?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }

  interface Window {
    paperclipDesktop?: PaperclipDesktopBridge;
  }
}

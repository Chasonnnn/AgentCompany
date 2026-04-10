import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("paperclipDesktop", {
  openLogs: () => ipcRenderer.invoke("paperclip-desktop:open-logs"),
  openDataFolder: () => ipcRenderer.invoke("paperclip-desktop:open-data-folder"),
  reloadApp: () => ipcRenderer.invoke("paperclip-desktop:reload-app"),
  chooseDirectory: () => ipcRenderer.invoke("paperclip-desktop:choose-directory"),
  revealPath: (targetPath: string) => ipcRenderer.invoke("paperclip-desktop:reveal-path", targetPath),
});

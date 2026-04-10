import type { MenuItemConstructorOptions, OpenDialogReturnValue } from "electron";

export interface DesktopUpdateMenuState {
  enabled: boolean;
  label: string;
}

interface ApplicationMenuTemplateInput {
  appName: string;
  platform: NodeJS.Platform;
  updateMenuState: DesktopUpdateMenuState;
  onCheckForUpdates: () => void;
}

export function createApplicationMenuTemplate(input: ApplicationMenuTemplateInput): MenuItemConstructorOptions[] {
  const updateMenuItem: MenuItemConstructorOptions = {
    id: "paperclip-check-for-updates",
    label: input.updateMenuState.label,
    enabled: input.updateMenuState.enabled,
    click: () => {
      input.onCheckForUpdates();
    },
  };

  if (input.platform === "darwin") {
    return [
      {
        label: input.appName,
        submenu: [
          { role: "about" },
          { type: "separator" },
          updateMenuItem,
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "pasteAndMatchStyle" },
          { type: "separator" },
          { role: "selectAll" },
        ],
      },
      { role: "windowMenu" },
    ];
  }

  return [
    {
      label: "Paperclip",
      submenu: [
        updateMenuItem,
        { type: "separator" },
        { role: "quit" },
      ],
    },
  ];
}

export function readChosenDirectory(result: Pick<OpenDialogReturnValue, "canceled" | "filePaths">): string | null {
  if (result.canceled) return null;
  return result.filePaths[0] ?? null;
}

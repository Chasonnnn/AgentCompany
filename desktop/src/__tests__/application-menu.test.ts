import { describe, expect, test, vi } from "vitest";
import { createApplicationMenuTemplate, readChosenDirectory } from "../runtime/application-menu.js";

describe("application-menu", () => {
  test("includes standard edit actions on macOS", () => {
    const onCheckForUpdates = vi.fn();
    const template = createApplicationMenuTemplate({
      appName: "Paperclip",
      platform: "darwin",
      updateMenuState: {
        enabled: true,
        label: "Check for Updates…",
      },
      onCheckForUpdates,
    });

    const editMenu = template.find((item) => item.label === "Edit");
    expect(editMenu).toBeDefined();
    expect(editMenu?.submenu).toEqual([
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "pasteAndMatchStyle" },
      { type: "separator" },
      { role: "selectAll" },
    ]);
  });

  test("returns the first selected directory path", () => {
    expect(
      readChosenDirectory({
        canceled: false,
        filePaths: ["/Users/chason/code/paperclip"],
      }),
    ).toBe("/Users/chason/code/paperclip");
  });

  test("returns null when directory selection is canceled", () => {
    expect(
      readChosenDirectory({
        canceled: true,
        filePaths: ["/Users/chason/code/paperclip"],
      }),
    ).toBeNull();
  });
});

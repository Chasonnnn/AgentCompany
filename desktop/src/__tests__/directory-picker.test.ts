import path from "node:path";
import { describe, expect, test } from "vitest";
import { resolveDirectoryPickerDefaultPath } from "../runtime/directory-picker.js";

describe("directory-picker", () => {
  test("starts folder selection in Paperclip-owned workspace storage", () => {
    expect(resolveDirectoryPickerDefaultPath("/Users/chason/Library/Application Support/@paperclipai/desktop/paperclip"))
      .toBe(path.resolve("/Users/chason/Library/Application Support/@paperclipai/desktop/paperclip/workspaces"));
  });
});

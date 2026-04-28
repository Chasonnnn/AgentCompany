import path from "node:path";

const DEFAULT_WORKSPACE_DIRECTORY_NAME = "workspaces";

export function resolveDirectoryPickerDefaultPath(paperclipHome: string): string {
  return path.resolve(paperclipHome, DEFAULT_WORKSPACE_DIRECTORY_NAME);
}

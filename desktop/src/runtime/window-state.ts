import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type WindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SavedWindowState = {
  bounds: WindowBounds;
  isMaximized: boolean;
};

export const DEFAULT_WINDOW_STATE: SavedWindowState = {
  bounds: {
    width: 1440,
    height: 920,
    x: 120,
    y: 80,
  },
  isMaximized: false,
};

export function loadWindowState(filePath: string): SavedWindowState {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<SavedWindowState>;
    if (
      parsed &&
      parsed.bounds &&
      Number.isFinite(parsed.bounds.width) &&
      Number.isFinite(parsed.bounds.height) &&
      Number.isFinite(parsed.bounds.x) &&
      Number.isFinite(parsed.bounds.y)
    ) {
      return {
        bounds: {
          width: parsed.bounds.width,
          height: parsed.bounds.height,
          x: parsed.bounds.x,
          y: parsed.bounds.y,
        },
        isMaximized: parsed.isMaximized === true,
      };
    }
  } catch {
    return DEFAULT_WINDOW_STATE;
  }

  return DEFAULT_WINDOW_STATE;
}

export function saveWindowState(filePath: string, state: SavedWindowState): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(state, null, 2));
}

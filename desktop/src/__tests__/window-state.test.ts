import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_WINDOW_STATE,
  loadWindowState,
  saveWindowState,
} from "../runtime/window-state.js";

const tempDirs: string[] = [];

async function createTempDir(prefix: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("window-state", () => {
  test("returns defaults when no saved state exists", async () => {
    const dir = await createTempDir("paperclip-window-state-");
    expect(loadWindowState(path.join(dir, "missing.json"))).toEqual(DEFAULT_WINDOW_STATE);
  });

  test("persists and reloads saved window bounds", async () => {
    const dir = await createTempDir("paperclip-window-state-");
    const filePath = path.join(dir, "window-state.json");
    const expectedState = {
      bounds: {
        x: 20,
        y: 30,
        width: 1600,
        height: 980,
      },
      isMaximized: true,
    };

    saveWindowState(filePath, expectedState);

    expect(loadWindowState(filePath)).toEqual(expectedState);
  });
});

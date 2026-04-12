import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeLocalInstancePaths,
  expandHomePrefix,
  resolvePaperclipHomeDir,
  resolvePaperclipInstanceId,
} from "../config/home.js";

const ORIGINAL_ENV = { ...process.env };

describe("home path resolution", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("defaults to ~/.paperclip and default instance", () => {
    delete process.env.PAPERCLIP_HOME;
    delete process.env.PAPERCLIP_INSTANCE_ID;

    const fakeHome = mkdtempSync(path.join(os.tmpdir(), "paperclip-home-"));
    const paths = describeLocalInstancePaths(undefined, { env: process.env, homeDir: fakeHome });
    expect(paths.homeDir).toBe(path.resolve(fakeHome, ".paperclip"));
    expect(paths.instanceId).toBe("default");
    expect(paths.configPath).toBe(
      path.resolve(fakeHome, ".paperclip", "instances", "default", "config.json"),
    );
  });

  it("prefers the desktop app home when a valid desktop instance exists", () => {
    delete process.env.PAPERCLIP_HOME;
    delete process.env.PAPERCLIP_INSTANCE_ID;

    const fakeHome = mkdtempSync(path.join(os.tmpdir(), "paperclip-home-"));
    const desktopInstanceRoot = path.resolve(
      fakeHome,
      "Library",
      "Application Support",
      "@paperclipai",
      "desktop",
      "paperclip",
      "instances",
      "default",
    );
    fs.mkdirSync(path.resolve(desktopInstanceRoot, "logs"), { recursive: true });

    const paths = describeLocalInstancePaths(undefined, { env: process.env, homeDir: fakeHome });
    expect(paths.homeDir).toBe(
      path.resolve(fakeHome, "Library", "Application Support", "@paperclipai", "desktop", "paperclip"),
    );
    expect(paths.instanceRoot).toBe(desktopInstanceRoot);
  });

  it("supports PAPERCLIP_HOME and explicit instance ids", () => {
    process.env.PAPERCLIP_HOME = "~/paperclip-home";

    const home = resolvePaperclipHomeDir({ env: process.env });
    expect(home).toBe(path.resolve(os.homedir(), "paperclip-home"));
    expect(resolvePaperclipInstanceId("dev_1")).toBe("dev_1");
  });

  it("rejects invalid instance ids", () => {
    expect(() => resolvePaperclipInstanceId("bad/id")).toThrow(/Invalid instance id/);
  });

  it("expands ~ prefixes", () => {
    expect(expandHomePrefix("~")).toBe(os.homedir());
    expect(expandHomePrefix("~/x/y")).toBe(path.resolve(os.homedir(), "x/y"));
  });
});

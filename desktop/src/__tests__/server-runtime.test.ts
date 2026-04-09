import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  augmentDesktopPath,
  buildDesktopServerEnv,
  resolveDesktopPaperclipHome,
  resolveDesktopServerRoot,
  startManagedServer,
} from "../runtime/server-runtime.js";

const tempDirs: string[] = [];

async function createTempDir(prefix: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeServerEntry(serverRoot: string, source: string) {
  const distDir = path.join(serverRoot, "dist");
  await mkdir(distDir, { recursive: true });
  await writeFile(path.join(distDir, "index.js"), source);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("server-runtime", () => {
  test("augments PATH with user-managed CLI directories and common macOS bins", async () => {
    const homeDir = await createTempDir("paperclip-desktop-home-");
    await mkdir(path.join(homeDir, ".local", "bin"), { recursive: true });
    await mkdir(path.join(homeDir, "Library", "pnpm"), { recursive: true });
    await mkdir(path.join(homeDir, ".nvm", "versions", "node", "v20.18.1", "bin"), { recursive: true });
    await mkdir(path.join(homeDir, ".nvm", "versions", "node", "v24.13.0", "bin"), { recursive: true });

    const augmented = augmentDesktopPath("/usr/bin:/custom/bin:/usr/local/bin", homeDir);
    expect(augmented.split(path.delimiter)).toEqual([
      "/usr/bin",
      "/custom/bin",
      "/usr/local/bin",
      path.join(homeDir, ".local", "bin"),
      path.join(homeDir, "Library", "pnpm"),
      path.join(homeDir, ".nvm", "versions", "node", "v24.13.0", "bin"),
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/sbin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      "/Library/Apple/usr/bin",
    ]);
  });

  test("builds the packaged server environment", () => {
    const env = buildDesktopServerEnv({
      baseEnv: { PATH: "/custom/bin", HOME: "/tmp/test-home" },
      paperclipHome: "/tmp/paperclip-home",
      port: 4310,
    });

    expect(env.HOST).toBe("127.0.0.1");
    expect(env.PORT).toBe("4310");
    expect(env.SERVE_UI).toBe("true");
    expect(env.PAPERCLIP_UI_DEV_MIDDLEWARE).toBe("false");
    expect(env.PAPERCLIP_HOME).toBe("/tmp/paperclip-home");
    expect(env.PAPERCLIP_DEPLOYMENT_MODE).toBe("local_trusted");
    expect(env.PAPERCLIP_DEPLOYMENT_EXPOSURE).toBe("private");
    expect(env.PAPERCLIP_INSTANCE_ID).toBe("default");
    expect(env.PATH?.split(path.delimiter)[0]).toBe("/custom/bin");
  });

  test("resolves runtime roots for packaged and unpackaged app modes", () => {
    expect(
      resolveDesktopServerRoot({
        isPackaged: true,
        appPath: "/Applications/Paperclip.app/Contents/Resources/app.asar",
        resourcesPath: "/Applications/Paperclip.app/Contents/Resources",
      }),
    ).toBe("/Applications/Paperclip.app/Contents/Resources/server");

    expect(
      resolveDesktopServerRoot({
        isPackaged: false,
        appPath: "/Users/chason/paperclip/desktop",
        resourcesPath: "/ignored",
      }),
    ).toBe("/Users/chason/paperclip/desktop/.stage/server");
  });

  test("starts a managed server, waits for health, and shuts it down cleanly", async () => {
    const serverRoot = await createTempDir("paperclip-desktop-server-");
    const userDataDir = await createTempDir("paperclip-desktop-userdata-");

    await writeServerEntry(
      serverRoot,
      `
        const http = require("node:http");
        const server = http.createServer((req, res) => {
          if (req.url === "/api/health") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          res.writeHead(404);
          res.end("not found");
        });
        server.listen(Number(process.env.PORT), process.env.HOST);
        process.on("SIGTERM", () => {
          server.close(() => process.exit(0));
        });
      `,
    );

    const handle = await startManagedServer({
      userDataPath: userDataDir,
      serverRoot,
      preferredPort: 4381,
      startupTimeoutMs: 5_000,
    });

    expect(handle.paperclipHome).toBe(resolveDesktopPaperclipHome(userDataDir));

    const healthResponse = await fetch(new URL("/api/health", handle.apiUrl));
    expect(healthResponse.status).toBe(200);
    expect(await healthResponse.json()).toEqual({ ok: true });

    await handle.stop();
    await expect(handle.whenExit).resolves.toMatchObject({ code: 0 });
  });

  test("surfaces recent logs when the packaged server exits during startup", async () => {
    const serverRoot = await createTempDir("paperclip-desktop-fail-");
    const userDataDir = await createTempDir("paperclip-desktop-userdata-");

    await writeServerEntry(
      serverRoot,
      `
        console.error("codex binary missing");
        setTimeout(() => process.exit(1), 50);
      `,
    );

    await expect(
      startManagedServer({
        userDataPath: userDataDir,
        serverRoot,
        preferredPort: 4382,
        startupTimeoutMs: 1_000,
      }),
    ).rejects.toThrow(/Recent server logs:[\s\S]*codex binary missing/);
  });
});

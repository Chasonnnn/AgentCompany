import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  normalizeStagedWorkspacePackages,
  toRuntimePackageManifest,
} from "../runtime/staged-package-manifest.js";

const tempDirs: string[] = [];

async function createTempDir(prefix: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("staged-package-manifest", () => {
  test("maps Paperclip workspace manifests to publish-time runtime entries", () => {
    expect(
      toRuntimePackageManifest({
        name: "@paperclipai/db",
        exports: {
          ".": "./src/index.ts",
        },
        publishConfig: {
          exports: {
            ".": {
              import: "./dist/index.js",
              types: "./dist/index.d.ts",
            },
          },
          main: "./dist/index.js",
          types: "./dist/index.d.ts",
        },
      }),
    ).toMatchObject({
      exports: {
        ".": {
          import: "./dist/index.js",
          types: "./dist/index.d.ts",
        },
      },
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
    });
  });

  test("rewrites all staged @paperclipai package manifests under node_modules", async () => {
    const stageDir = await createTempDir("paperclip-desktop-stage-");
    const realPackageDir = path.join(
      stageDir,
      "node_modules",
      ".pnpm",
      "@paperclipai+db@file+packages+db",
      "node_modules",
      "@paperclipai",
      "db",
    );
    await mkdir(realPackageDir, { recursive: true });
    await writeFile(
      path.join(realPackageDir, "package.json"),
      JSON.stringify(
        {
          name: "@paperclipai/db",
          exports: {
            ".": "./src/index.ts",
            "./*": "./src/*.ts",
          },
          publishConfig: {
            exports: {
              ".": {
                import: "./dist/index.js",
                types: "./dist/index.d.ts",
              },
              "./*": {
                import: "./dist/*.js",
                types: "./dist/*.d.ts",
              },
            },
            main: "./dist/index.js",
            types: "./dist/index.d.ts",
          },
        },
        null,
        2,
      ),
    );

    const rootScopeDir = path.join(stageDir, "node_modules", "@paperclipai");
    await mkdir(rootScopeDir, { recursive: true });
    await symlink(realPackageDir, path.join(rootScopeDir, "db"));

    const rewritten = await normalizeStagedWorkspacePackages(stageDir);

    expect(rewritten).toBe(1);
    const manifest = JSON.parse(await readFile(path.join(realPackageDir, "package.json"), "utf8"));
    expect(manifest.exports).toEqual({
      ".": {
        import: "./dist/index.js",
        types: "./dist/index.d.ts",
      },
      "./*": {
        import: "./dist/*.js",
        types: "./dist/*.d.ts",
      },
    });
    expect(manifest.main).toBe("./dist/index.js");
    expect(manifest.types).toBe("./dist/index.d.ts");
  });
});

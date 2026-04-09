import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const {
  createDesktopBuildMetadata,
  readDesktopPackageVersion,
} = require("../dist/runtime/build-metadata.js");

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: desktopDir,
      stdio: "inherit",
      env,
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed with ${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`}.`,
        ),
      );
    });
  });
}

async function main() {
  const mode = process.argv[2];
  if (mode !== "package" && mode !== "dist") {
    throw new Error("Usage: node ./scripts/run-electron-builder.mjs <package|dist>");
  }

  const packageVersion = await readDesktopPackageVersion(path.join(desktopDir, "package.json"));
  const metadata = createDesktopBuildMetadata({
    packageVersion,
    env: {
      ...process.env,
      PAPERCLIP_DESKTOP_RELEASE_CHANNEL:
        process.env.PAPERCLIP_DESKTOP_RELEASE_CHANNEL ?? (mode === "dist" ? "main" : "local"),
    },
  });

  const env = {
    ...process.env,
    PAPERCLIP_DESKTOP_BUILD_MODE: mode,
    PAPERCLIP_DESKTOP_BUILD_VERSION: metadata.version,
    PAPERCLIP_DESKTOP_BUILT_AT: metadata.builtAt,
    PAPERCLIP_DESKTOP_RELEASE_CHANNEL: metadata.channel,
    PAPERCLIP_DESKTOP_FEED_URL: metadata.feedUrl ?? "",
  };

  await run(process.execPath, ["./scripts/write-build-metadata.mjs"], env);

  const electronBuilderBin = path.join(
    desktopDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "electron-builder.cmd" : "electron-builder",
  );
  const args = ["--config", "electron-builder.config.cjs", "--publish", "never"];
  if (mode === "package") {
    args.push("--dir");
  }

  await run(electronBuilderBin, args, env);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

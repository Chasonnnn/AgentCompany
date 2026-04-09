const { access } = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
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

module.exports = async function adHocSignApp(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const productFilename =
    context.packager?.appInfo?.productFilename ??
    context.packager?.config?.productName ??
    "Paperclip";
  const appBundlePath = path.join(context.appOutDir, `${productFilename}.app`);

  await access(appBundlePath);
  await run("codesign", ["--force", "--deep", "--sign", "-", appBundlePath], context.appOutDir);
};

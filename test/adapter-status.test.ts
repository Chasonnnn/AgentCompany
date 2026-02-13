import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { setProviderBin } from "../src/machine/machine.js";
import { listAdapterStatuses } from "../src/adapters/registry.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

async function writeFakeCodexWithAppServer(dir: string): Promise<string> {
  const p = path.join(dir, "codex");
  const src = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "app-server" && args[1] === "--help") {
  process.stdout.write("ok\\n");
  process.exit(0);
}
process.exit(0);
`;
  await fs.writeFile(p, src, { encoding: "utf8", mode: 0o755 });
  return p;
}

describe("adapter registry", () => {
  test("marks codex_app_server adapter available when codex supports app-server", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const fakeCodex = await writeFakeCodexWithAppServer(dir);
    await setProviderBin(dir, "codex", fakeCodex);

    const adapters = await listAdapterStatuses(dir);
    const protocol = adapters.find((a) => a.name === "codex_app_server");
    expect(protocol).toBeDefined();
    expect(protocol?.available).toBe(true);
    expect(protocol?.mode).toBe("protocol");
  });
});

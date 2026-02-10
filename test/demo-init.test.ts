import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { demoInit } from "../src/demo/demo_init.js";
import { validateWorkspace } from "../src/workspace/validate.js";

async function mkTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
  return dir;
}

describe("demo init", () => {
  test("demoInit creates a workspace that validates", async () => {
    const dir = await mkTmpDir();
    await demoInit({ workspace_dir: dir, company_name: "DemoCo" });
    const res = await validateWorkspace(dir);
    expect(res.ok).toBe(true);
  });
});


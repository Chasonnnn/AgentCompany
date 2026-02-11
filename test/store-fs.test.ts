import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { writeFileAtomic } from "../src/store/fs.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

describe("store fs writes", () => {
  test("writeFileAtomic creates missing parent directories", async () => {
    const dir = await mkTmpDir();
    const filePath = path.join(dir, "nested", "deep", "file.txt");
    await writeFileAtomic(filePath, "hello");
    const content = await fs.readFile(filePath, { encoding: "utf8" });
    expect(content).toBe("hello");
  });

  test("workspace writes create lock directory for cross-process coordination", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const target = path.join(dir, "company", "policy.yaml");
    await writeFileAtomic(target, "schema_version: 1\n");
    const stat = await fs.stat(path.join(dir, ".local", "locks"));
    expect(stat.isDirectory()).toBe(true);
  });
});

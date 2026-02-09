import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { validateWorkspace } from "../src/workspace/validate.js";

async function mkTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
  return dir;
}

describe("workspace init/validate", () => {
  test("init creates a valid workspace", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const res = await validateWorkspace(dir);
    expect(res.ok).toBe(true);
  });

  test("validate fails when required file is missing", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    await fs.rm(path.join(dir, "company/company.yaml"));
    const res = await validateWorkspace(dir);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.code === "missing_file")).toBe(true);
    }
  });

  test("init refuses non-empty directory unless forced", async () => {
    const dir = await mkTmpDir();
    await fs.writeFile(path.join(dir, "somefile.txt"), "x", { encoding: "utf8" });
    await expect(initWorkspace({ root_dir: dir, company_name: "Acme" })).rejects.toThrow(
      /Refusing to initialize/
    );
    await expect(initWorkspace({ root_dir: dir, company_name: "Acme", force: true })).resolves.toBe(
      undefined
    );
  });
});

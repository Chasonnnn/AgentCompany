import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listGeminiSkills,
  syncGeminiSkills,
} from "@agentcompany/adapter-gemini-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("gemini local skill sync", () => {
  const agentcompanyKey = "agentcompany/agentcompany/paperclip";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("reports configured AgentCompany skills and installs them into the Gemini skills home", async () => {
    const home = await makeTempDir("paperclip-gemini-skill-sync-");
    cleanupDirs.add(home);

    const ctx = {
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "gemini_local",
      config: {
        env: {
          HOME: home,
        },
        agentcompanySkillSync: {
          desiredSkills: [agentcompanyKey],
        },
      },
    } as const;

    const before = await listGeminiSkills(ctx);
    expect(before.mode).toBe("persistent");
    expect(before.desiredSkills).toContain(agentcompanyKey);
    expect(before.entries.find((entry) => entry.key === agentcompanyKey)?.required).toBe(true);
    expect(before.entries.find((entry) => entry.key === agentcompanyKey)?.state).toBe("missing");

    const after = await syncGeminiSkills(ctx, [agentcompanyKey]);
    expect(after.entries.find((entry) => entry.key === agentcompanyKey)?.state).toBe("installed");
    expect((await fs.lstat(path.join(home, ".gemini", "skills", "paperclip"))).isSymbolicLink()).toBe(true);
  });

  it("keeps required bundled AgentCompany skills installed even when the desired set is emptied", async () => {
    const home = await makeTempDir("paperclip-gemini-skill-prune-");
    cleanupDirs.add(home);

    const configuredCtx = {
      agentId: "agent-2",
      companyId: "company-1",
      adapterType: "gemini_local",
      config: {
        env: {
          HOME: home,
        },
        agentcompanySkillSync: {
          desiredSkills: [agentcompanyKey],
        },
      },
    } as const;

    await syncGeminiSkills(configuredCtx, [agentcompanyKey]);

    const clearedCtx = {
      ...configuredCtx,
      config: {
        env: {
          HOME: home,
        },
        agentcompanySkillSync: {
          desiredSkills: [],
        },
      },
    } as const;

    const after = await syncGeminiSkills(clearedCtx, []);
    expect(after.desiredSkills).toContain(agentcompanyKey);
    expect(after.entries.find((entry) => entry.key === agentcompanyKey)?.state).toBe("installed");
    expect((await fs.lstat(path.join(home, ".gemini", "skills", "paperclip"))).isSymbolicLink()).toBe(true);
  });
});

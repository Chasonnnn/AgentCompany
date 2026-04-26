import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  instanceSettings,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres mention-terminated tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueService.resolveMentionedAgents — terminated agents", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-mention-terminated-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  }, 30_000);

  afterEach(async () => {
    await db.delete(agents);
  });

  afterAll(async () => {
    await db.delete(instanceSettings);
    await db.delete(companies);
    await tempDb?.cleanup();
  });

  function makeAgent(id: string, name: string, status: string) {
    return {
      id,
      companyId,
      name,
      role: "engineer",
      status,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    };
  }

  it("returns droppedMentions.terminated for both name tokens and explicit agent:// IDs", async () => {
    const liveId = randomUUID();
    const deadByNameId = randomUUID();
    const deadByExplicitId = randomUUID();
    await db.insert(agents).values([
      makeAgent(liveId, "live-alpha", "idle"),
      makeAgent(deadByNameId, "dead-beta", "terminated"),
      makeAgent(deadByExplicitId, "Gamma", "terminated"),
    ]);

    const body = `hello @live-alpha and @dead-beta and [@Gamma](agent://${deadByExplicitId})`;
    const result = await svc.resolveMentionedAgents(companyId, body);

    expect(result.agentIds).toEqual([liveId]);
    expect(result.ambiguousTokens).toEqual([]);
    expect(result.droppedMentions.terminated).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ token: "dead-beta", agentId: deadByNameId, name: "dead-beta" }),
        expect.objectContaining({ agentId: deadByExplicitId, name: "Gamma" }),
      ]),
    );
    expect(result.droppedMentions.terminated).toHaveLength(2);
  });

  it("distinguishes unknown tokens from terminated tokens", async () => {
    const liveId = randomUUID();
    const deadId = randomUUID();
    await db.insert(agents).values([
      makeAgent(liveId, "live-alpha", "idle"),
      makeAgent(deadId, "dead-beta", "terminated"),
    ]);

    const body = "@live-alpha @dead-beta @nobody";
    const result = await svc.resolveMentionedAgents(companyId, body);

    expect(result.agentIds).toEqual([liveId]);
    expect(result.droppedMentions.terminated).toEqual([
      expect.objectContaining({ token: "dead-beta", agentId: deadId, name: "dead-beta" }),
    ]);
    // @nobody should NOT appear — unknown != terminated
    expect(
      result.droppedMentions.terminated.some((entry) => entry.name === "nobody" || entry.token === "nobody"),
    ).toBe(false);
  });

  it("does not flag paused / pending_approval agents (only `terminated` is a tombstone)", async () => {
    const pausedId = randomUUID();
    const pendingId = randomUUID();
    await db.insert(agents).values([
      makeAgent(pausedId, "paused-pat", "paused"),
      makeAgent(pendingId, "pending-pete", "pending_approval"),
    ]);

    const body = "@paused-pat @pending-pete";
    const result = await svc.resolveMentionedAgents(companyId, body);

    // Both resolve as live agents (paused/pending are recoverable, not tombstones)
    expect(result.agentIds.sort()).toEqual([pausedId, pendingId].sort());
    expect(result.droppedMentions.terminated).toEqual([]);
  });

  it("returns empty droppedMentions when there are no mentions", async () => {
    const result = await svc.resolveMentionedAgents(companyId, "no mentions here");
    expect(result.agentIds).toEqual([]);
    expect(result.ambiguousTokens).toEqual([]);
    expect(result.droppedMentions.terminated).toEqual([]);
  });

  it("getAgentStatusById returns the agent's status, or null if unknown", async () => {
    const liveId = randomUUID();
    const deadId = randomUUID();
    await db.insert(agents).values([
      makeAgent(liveId, "live-charlie", "idle"),
      makeAgent(deadId, "dead-delta", "terminated"),
    ]);

    expect(await svc.getAgentStatusById(liveId)).toBe("idle");
    expect(await svc.getAgentStatusById(deadId)).toBe("terminated");
    expect(await svc.getAgentStatusById(randomUUID())).toBeNull();
  });
});

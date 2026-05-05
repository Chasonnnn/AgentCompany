import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  environments,
  executionWorkspaces,
  goals,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueInboxArchives,
  issueRelations,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

async function insertProject(db: ReturnType<typeof createDb>, companyId: string, name = "Test project") {
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    companyId,
    name,
    status: "in_progress",
  });
  return projectId;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueService.list participantAgentId", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-service-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns issues an agent participated in across the supported signals", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = await insertProject(db, companyId, "Participation");

    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "OtherAgent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const assignedIssueId = randomUUID();
    const createdIssueId = randomUUID();
    const commentedIssueId = randomUUID();
    const activityIssueId = randomUUID();
    const excludedIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: assignedIssueId,
        companyId,
        projectId,
        title: "Assigned issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        createdByAgentId: otherAgentId,
      },
      {
        id: createdIssueId,
        companyId,
        projectId,
        title: "Created issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: agentId,
      },
      {
        id: commentedIssueId,
        companyId,
        projectId,
        title: "Commented issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: otherAgentId,
      },
      {
        id: activityIssueId,
        companyId,
        projectId,
        title: "Activity issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: otherAgentId,
      },
      {
        id: excludedIssueId,
        companyId,
        projectId,
        title: "Excluded issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: otherAgentId,
        assigneeAgentId: otherAgentId,
      },
    ]);

    await db.insert(issueComments).values({
      companyId,
      issueId: commentedIssueId,
      authorAgentId: agentId,
      body: "Investigating this issue.",
    });

    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: activityIssueId,
      agentId,
      details: { changed: true },
    });

    const result = await svc.list(companyId, { participantAgentId: agentId });
    const resultIds = new Set(result.map((issue) => issue.id));

    expect(resultIds).toEqual(new Set([
      assignedIssueId,
      createdIssueId,
      commentedIssueId,
      activityIssueId,
    ]));
    expect(resultIds.has(excludedIssueId)).toBe(false);
  });

  it("combines participation filtering with search", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = await insertProject(db, companyId, "Participation search");

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const matchedIssueId = randomUUID();
    const otherIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: matchedIssueId,
        companyId,
        projectId,
        title: "Invoice reconciliation",
        status: "todo",
        priority: "medium",
        createdByAgentId: agentId,
      },
      {
        id: otherIssueId,
        companyId,
        projectId,
        title: "Weekly planning",
        status: "todo",
        priority: "medium",
        createdByAgentId: agentId,
      },
    ]);

    const result = await svc.list(companyId, {
      participantAgentId: agentId,
      q: "invoice",
    });

    expect(result.map((issue) => issue.id)).toEqual([matchedIssueId]);
  });

  it("applies result limits to issue search", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = await insertProject(db, companyId, "Search limits");

    const exactIdentifierId = randomUUID();
    const titleMatchId = randomUUID();
    const descriptionMatchId = randomUUID();

    await db.insert(issues).values([
      {
        id: exactIdentifierId,
        companyId,
        projectId,
        issueNumber: 42,
        identifier: "PAP-42",
        title: "Completely unrelated",
        status: "todo",
        priority: "medium",
      },
      {
        id: titleMatchId,
        companyId,
        projectId,
        title: "Search ranking issue",
        status: "todo",
        priority: "medium",
      },
      {
        id: descriptionMatchId,
        companyId,
        projectId,
        title: "Another item",
        description: "Contains the search keyword",
        status: "todo",
        priority: "medium",
      },
    ]);

    const result = await svc.list(companyId, {
      q: "search",
      limit: 2,
    });

    expect(result.map((issue) => issue.id)).toEqual([titleMatchId, descriptionMatchId]);
  });

  it("ranks comment matches ahead of description-only matches", async () => {
    const companyId = randomUUID();
    const commentMatchId = randomUUID();
    const descriptionMatchId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = await insertProject(db, companyId, "Comment ranking");

    await db.insert(issues).values([
      {
        id: commentMatchId,
        companyId,
        projectId,
        title: "Comment match",
        status: "todo",
        priority: "medium",
      },
      {
        id: descriptionMatchId,
        companyId,
        projectId,
        title: "Description match",
        description: "Contains pull/3303 in the description",
        status: "todo",
        priority: "medium",
      },
    ]);

    await db.insert(issueComments).values({
      companyId,
      issueId: commentMatchId,
      body: "Reference: https://github.com/paperclipai/paperclip/pull/3303",
    });

    const result = await svc.list(companyId, {
      q: "pull/3303",
      limit: 2,
      includeRoutineExecutions: true,
    });

    expect(result.map((issue) => issue.id)).toEqual([commentMatchId, descriptionMatchId]);
  });

  it("filters issue lists to the full descendant tree for a root issue", async () => {
    const companyId = randomUUID();
    const rootId = randomUUID();
    const childId = randomUUID();
    const grandchildId = randomUUID();
    const siblingId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = await insertProject(db, companyId, "Descendant tree");

    await db.insert(issues).values([
      {
        id: rootId,
        companyId,
        projectId,
        title: "Root",
        status: "todo",
        priority: "medium",
      },
      {
        id: childId,
        companyId,
        projectId,
        parentId: rootId,
        title: "Child",
        status: "todo",
        priority: "medium",
      },
      {
        id: grandchildId,
        companyId,
        projectId,
        parentId: childId,
        title: "Grandchild",
        status: "todo",
        priority: "medium",
      },
      {
        id: siblingId,
        companyId,
        projectId,
        title: "Sibling",
        status: "todo",
        priority: "medium",
      },
    ]);

    const result = await svc.list(companyId, { descendantOf: rootId });

    expect(new Set(result.map((issue) => issue.id))).toEqual(new Set([childId, grandchildId]));
  });

  it("combines descendant filtering with search", async () => {
    const companyId = randomUUID();
    const rootId = randomUUID();
    const childId = randomUUID();
    const grandchildId = randomUUID();
    const outsideMatchId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = await insertProject(db, companyId, "Descendant search");

    await db.insert(issues).values([
      {
        id: rootId,
        companyId,
        projectId,
        title: "Root",
        status: "todo",
        priority: "medium",
      },
      {
        id: childId,
        companyId,
        projectId,
        parentId: rootId,
        title: "Relevant parent",
        status: "todo",
        priority: "medium",
      },
      {
        id: grandchildId,
        companyId,
        projectId,
        parentId: childId,
        title: "Needle grandchild",
        status: "todo",
        priority: "medium",
      },
      {
        id: outsideMatchId,
        companyId,
        projectId,
        title: "Needle outside",
        status: "todo",
        priority: "medium",
      },
    ]);

    const result = await svc.list(companyId, { descendantOf: rootId, q: "needle" });

    expect(result.map((issue) => issue.id)).toEqual([grandchildId]);
  });

  it("accepts issue identifiers with alphanumeric prefixes through getById", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PC1A2",
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = await insertProject(db, companyId, "Get by id");

    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      issueNumber: 1064,
      identifier: "PC1A2-1064",
      title: "Feedback votes error",
      status: "todo",
      priority: "medium",
      createdByUserId: "user-1",
    });

    const issue = await svc.getById("pc1a2-1064");

    expect(issue).toEqual(
      expect.objectContaining({
        id: issueId,
        identifier: "PC1A2-1064",
      }),
    );
  });

  it("returns null instead of throwing for malformed non-uuid issue refs", async () => {
    await expect(svc.getById("not-a-uuid")).resolves.toBeNull();
  });

  it("filters issues by execution workspace id", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const targetWorkspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const linkedIssueId = randomUUID();
    const otherLinkedIssueId = randomUUID();
    const unlinkedIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(executionWorkspaces).values([
      {
        id: targetWorkspaceId,
        companyId,
        projectId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "Target workspace",
        status: "active",
        providerType: "local_fs",
      },
      {
        id: otherWorkspaceId,
        companyId,
        projectId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "Other workspace",
        status: "active",
        providerType: "local_fs",
      },
    ]);

    await db.insert(issues).values([
      {
        id: linkedIssueId,
        companyId,
        projectId,
        title: "Linked issue",
        status: "todo",
        priority: "medium",
        executionWorkspaceId: targetWorkspaceId,
      },
      {
        id: otherLinkedIssueId,
        companyId,
        projectId,
        title: "Other linked issue",
        status: "todo",
        priority: "medium",
        executionWorkspaceId: otherWorkspaceId,
      },
      {
        id: unlinkedIssueId,
        companyId,
        projectId,
        title: "Unlinked issue",
        status: "todo",
        priority: "medium",
      },
    ]);

    const result = await svc.list(companyId, { executionWorkspaceId: targetWorkspaceId });

    expect(result.map((issue) => issue.id)).toEqual([linkedIssueId]);
  });

  it("filters issues by generic workspace id across execution and project workspace links", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const executionLinkedIssueId = randomUUID();
    const projectLinkedIssueId = randomUUID();
    const otherIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Feature workspace",
      sourceType: "local_path",
      visibility: "default",
      isPrimary: false,
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Execution workspace",
      status: "active",
      providerType: "git_worktree",
    });

    await db.insert(issues).values([
      {
        id: executionLinkedIssueId,
        companyId,
        projectId,
        projectWorkspaceId,
        title: "Execution linked issue",
        status: "done",
        priority: "medium",
        executionWorkspaceId,
      },
      {
        id: projectLinkedIssueId,
        companyId,
        projectId,
        projectWorkspaceId,
        title: "Project linked issue",
        status: "todo",
        priority: "medium",
      },
      {
        id: otherIssueId,
        companyId,
        projectId,
        title: "Other issue",
        status: "todo",
        priority: "medium",
      },
    ]);

    const executionResult = await svc.list(companyId, { workspaceId: executionWorkspaceId });
    const projectResult = await svc.list(companyId, { workspaceId: projectWorkspaceId });

    expect(executionResult.map((issue) => issue.id)).toEqual([executionLinkedIssueId]);
    expect(projectResult.map((issue) => issue.id).sort()).toEqual([executionLinkedIssueId, projectLinkedIssueId].sort());
  });

  it("hides plugin operation issues from default lists and inbox-style filters while preserving explicit retrieval", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const normalIssueId = randomUUID();
    const pluginVisibleIssueId = randomUUID();
    const operationIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Plugin Runner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Plugin operations",
      status: "in_progress",
    });
    await db.insert(issues).values([
      {
        id: normalIssueId,
        companyId,
        projectId,
        title: "Normal issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: pluginVisibleIssueId,
        companyId,
        projectId,
        title: "Plugin-visible issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        originKind: "plugin:paperclip.missions:feature",
      },
      {
        id: operationIssueId,
        companyId,
        projectId,
        title: "Plugin operation issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        originKind: "plugin:paperclip.missions:operation",
        originId: "mission-alpha:operation-1",
      },
    ]);

    const defaultIssueIds = (await svc.list(companyId)).map((issue) => issue.id);
    expect(defaultIssueIds).toContain(normalIssueId);
    expect(defaultIssueIds).toContain(pluginVisibleIssueId);
    expect(defaultIssueIds).not.toContain(operationIssueId);

    const inboxIssueIds = (await svc.list(companyId, {
      assigneeAgentId: agentId,
      status: "todo,in_progress,blocked",
      includeRoutineExecutions: true,
    })).map((issue) => issue.id);
    expect(inboxIssueIds).toContain(normalIssueId);
    expect(inboxIssueIds).not.toContain(operationIssueId);

    await expect(svc.list(companyId, { originKind: "plugin:paperclip.missions:operation" }))
      .resolves.toEqual([expect.objectContaining({ id: operationIssueId })]);
    await expect(svc.list(companyId, { originId: "mission-alpha:operation-1" }))
      .resolves.toEqual([expect.objectContaining({ id: operationIssueId })]);

    const projectIssueIds = (await svc.list(companyId, { projectId })).map((issue) => issue.id);
    expect(projectIssueIds).toContain(operationIssueId);

    const advancedIssueIds = (await svc.list(companyId, { includePluginOperations: true })).map((issue) => issue.id);
    expect(advancedIssueIds).toContain(operationIssueId);
  });

  it("excludes plugin operation issues from unread inbox counts", async () => {
    const companyId = randomUUID();
    const userId = "board-user";
    const otherUserId = "other-user";
    const normalIssueId = randomUUID();
    const operationIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = await insertProject(db, companyId, "Unread plugin operations");
    await db.insert(issues).values([
      {
        id: normalIssueId,
        companyId,
        projectId,
        title: "Normal touched issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
      },
      {
        id: operationIssueId,
        companyId,
        projectId,
        title: "Plugin operation touched issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
        originKind: "plugin:paperclip.missions:operation",
      },
    ]);
    await db.insert(issueComments).values([
      {
        companyId,
        issueId: normalIssueId,
        authorUserId: otherUserId,
        body: "Unread normal update.",
      },
      {
        companyId,
        issueId: operationIssueId,
        authorUserId: otherUserId,
        body: "Unread operation update.",
      },
    ]);

    await expect(svc.countUnreadTouchedByUser(companyId, userId, "todo")).resolves.toBe(1);
  });

  it("hides archived inbox issues until new external activity arrives", async () => {
    const companyId = randomUUID();
    const userId = "user-1";
    const otherUserId = "user-2";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = await insertProject(db, companyId, "Inbox archives");

    const visibleIssueId = randomUUID();
    const archivedIssueId = randomUUID();
    const resurfacedIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: visibleIssueId,
        companyId,
        projectId,
        title: "Visible issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
        createdAt: new Date("2026-03-26T10:00:00.000Z"),
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
      {
        id: archivedIssueId,
        companyId,
        projectId,
        title: "Archived issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
        createdAt: new Date("2026-03-26T11:00:00.000Z"),
        updatedAt: new Date("2026-03-26T11:00:00.000Z"),
      },
      {
        id: resurfacedIssueId,
        companyId,
        projectId,
        title: "Resurfaced issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
        createdAt: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T12:00:00.000Z"),
      },
    ]);

    await svc.archiveInbox(companyId, archivedIssueId, userId, new Date("2026-03-26T12:30:00.000Z"));
    await svc.archiveInbox(companyId, resurfacedIssueId, userId, new Date("2026-03-26T13:00:00.000Z"));

    await db.insert(issueComments).values({
      companyId,
      issueId: resurfacedIssueId,
      authorUserId: otherUserId,
      body: "This should bring the issue back into Mine.",
      createdAt: new Date("2026-03-26T13:30:00.000Z"),
      updatedAt: new Date("2026-03-26T13:30:00.000Z"),
    });

    const archivedFiltered = await svc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
    });

    expect(archivedFiltered.map((issue) => issue.id)).toEqual([
      resurfacedIssueId,
      visibleIssueId,
    ]);

    await svc.unarchiveInbox(companyId, archivedIssueId, userId);

    const afterUnarchive = await svc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
    });

    expect(new Set(afterUnarchive.map((issue) => issue.id))).toEqual(new Set([
      visibleIssueId,
      archivedIssueId,
      resurfacedIssueId,
    ]));
  });

  it("resurfaces archived issue when status/updatedAt changes after archiving", async () => {
    const companyId = randomUUID();
    const userId = "user-1";
    const otherUserId = "user-2";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = await insertProject(db, companyId, "Inbox resurfacing");

    const issueId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Issue with old comment then status change",
      status: "todo",
      priority: "medium",
      createdByUserId: userId,
      createdAt: new Date("2026-03-26T10:00:00.000Z"),
      updatedAt: new Date("2026-03-26T10:00:00.000Z"),
    });

    // Old external comment before archiving
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorUserId: otherUserId,
      body: "Old comment before archive",
      createdAt: new Date("2026-03-26T11:00:00.000Z"),
      updatedAt: new Date("2026-03-26T11:00:00.000Z"),
    });

    // Archive after seeing the comment
    await svc.archiveInbox(
      companyId,
      issueId,
      userId,
      new Date("2026-03-26T12:00:00.000Z"),
    );

    // Verify it's archived
    const afterArchive = await svc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
    });
    expect(afterArchive.map((i) => i.id)).not.toContain(issueId);

    // Status/work update changes updatedAt (no new comment)
    await db
      .update(issues)
      .set({
        status: "in_progress",
        updatedAt: new Date("2026-03-26T13:00:00.000Z"),
      })
      .where(eq(issues.id, issueId));

    // Should resurface because updatedAt > archivedAt
    const afterUpdate = await svc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
    });
    expect(afterUpdate.map((i) => i.id)).toContain(issueId);
  });

  it("sorts and exposes last activity from comments and non-local issue activity logs", async () => {
    const companyId = randomUUID();
    const olderIssueId = randomUUID();
    const commentIssueId = randomUUID();
    const activityIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = await insertProject(db, companyId, "Last activity");

    await db.insert(issues).values([
      {
        id: olderIssueId,
        companyId,
        projectId,
        title: "Older issue",
        status: "todo",
        priority: "medium",
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
      {
        id: commentIssueId,
        companyId,
        projectId,
        title: "Comment activity issue",
        status: "todo",
        priority: "medium",
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
      {
        id: activityIssueId,
        companyId,
        projectId,
        title: "Logged activity issue",
        status: "todo",
        priority: "medium",
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
    ]);

    await db.insert(issueComments).values({
      companyId,
      issueId: commentIssueId,
      body: "New comment without touching issue.updatedAt",
      createdAt: new Date("2026-03-26T11:00:00.000Z"),
      updatedAt: new Date("2026-03-26T11:00:00.000Z"),
    });

    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "system",
        actorId: "system",
        action: "issue.document_updated",
        entityType: "issue",
        entityId: activityIssueId,
        createdAt: new Date("2026-03-26T12:00:00.000Z"),
      },
      {
        companyId,
        actorType: "user",
        actorId: "user-1",
        action: "issue.read_marked",
        entityType: "issue",
        entityId: olderIssueId,
        createdAt: new Date("2026-03-26T13:00:00.000Z"),
      },
    ]);

    const result = await svc.list(companyId, {});

    expect(result.map((issue) => issue.id)).toEqual([
      activityIssueId,
      commentIssueId,
      olderIssueId,
    ]);
    expect(result.find((issue) => issue.id === activityIssueId)?.lastActivityAt?.toISOString()).toBe(
      "2026-03-26T12:00:00.000Z",
    );
    expect(result.find((issue) => issue.id === commentIssueId)?.lastActivityAt?.toISOString()).toBe(
      "2026-03-26T11:00:00.000Z",
    );
    expect(result.find((issue) => issue.id === olderIssueId)?.lastActivityAt?.toISOString()).toBe(
      "2026-03-26T10:00:00.000Z",
    );
  });
  it("paginates earlier comments in descending order from an anchor comment", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const firstCommentId = randomUUID();
    const anchorCommentId = randomUUID();
    const latestCommentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Comment pagination",
      status: "in_progress",
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Paged comments issue",
      status: "todo",
      priority: "medium",
    });

    await db.insert(issueComments).values([
      {
        id: firstCommentId,
        companyId,
        issueId,
        body: "First comment",
        createdAt: new Date("2026-03-26T10:00:00.000Z"),
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
      {
        id: anchorCommentId,
        companyId,
        issueId,
        body: "Anchor comment",
        createdAt: new Date("2026-03-26T11:00:00.000Z"),
        updatedAt: new Date("2026-03-26T11:00:00.000Z"),
      },
      {
        id: latestCommentId,
        companyId,
        issueId,
        body: "Latest comment",
        createdAt: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T12:00:00.000Z"),
      },
    ]);

    const comments = await svc.listComments(issueId, {
      afterCommentId: anchorCommentId,
      order: "desc",
      limit: 50,
    });

    expect(comments.map((comment) => comment.id)).toEqual([firstCommentId]);
  });
});

describeEmbeddedPostgres("issueService.create workspace inheritance", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-create-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("does not implicitly inherit the parent execution workspace linkage when child workspace fields are omitted", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const parentIssueId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
      sharedWorkspaceKey: "workspace-key",
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Issue worktree",
      status: "active",
      providerType: "git_worktree",
      providerRef: `/tmp/${executionWorkspaceId}`,
    });

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        workspaceRuntime: { profile: "agent" },
      },
    });

    const child = await svc.create(companyId, {
      parentId: parentIssueId,
      projectId,
      title: "Child issue",
    });

    expect(child.parentId).toBe(parentIssueId);
    expect(child.projectWorkspaceId).toBe(projectWorkspaceId);
    expect(child.executionWorkspaceId).toBeNull();
    expect(child.executionWorkspacePreference).toBeNull();
    expect(child.executionWorkspaceSettings).toBeNull();
  });

  it("captures the assignee default environment when neither issue nor project specifies one", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const assigneeEnvironmentId = randomUUID();
    const assigneeAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(environments).values([
      {
        id: assigneeEnvironmentId,
        companyId,
        name: "QA E2B",
        driver: "sandbox",
        status: "active",
        config: { provider: "e2b" },
      },
    ]);

    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "QA E2B Codex",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      defaultEnvironmentId: assigneeEnvironmentId,
      permissions: {},
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: "shared_workspace",
        allowIssueOverride: true,
        defaultProjectWorkspaceId: projectWorkspaceId,
      },
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
    });

    const issue = await svc.create(companyId, {
      projectId,
      assigneeAgentId,
      title: "Environment matrix: e2b / codex_local",
      status: "todo",
      priority: "medium",
    });

    expect(issue.executionWorkspaceSettings).toEqual({
      mode: "shared_workspace",
      environmentId: assigneeEnvironmentId,
    });
  });

  it("does not promote the assignee default environment when the project policy already specifies one", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const projectEnvironmentId = randomUUID();
    const assigneeEnvironmentId = randomUUID();
    const assigneeAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(environments).values([
      {
        id: projectEnvironmentId,
        companyId,
        name: "QA SSH",
        driver: "ssh",
        status: "active",
        config: {},
      },
      {
        id: assigneeEnvironmentId,
        companyId,
        name: "QA E2B",
        driver: "sandbox",
        status: "active",
        config: { provider: "e2b" },
      },
    ]);

    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "QA E2B Codex",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      defaultEnvironmentId: assigneeEnvironmentId,
      permissions: {},
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: "shared_workspace",
        allowIssueOverride: true,
        defaultProjectWorkspaceId: projectWorkspaceId,
        environmentId: projectEnvironmentId,
      },
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
    });

    const issue = await svc.create(companyId, {
      projectId,
      assigneeAgentId,
      title: "Environment matrix: e2b / codex_local",
      status: "todo",
      priority: "medium",
    });

    // Project policy's environmentId must win over the assignee's default;
    // executionWorkspaceSettings should not bake in an environmentId in this case
    // so resolveExecutionWorkspaceEnvironmentId can fall through to the project
    // policy's value at run time.
    expect(issue.executionWorkspaceSettings).toEqual({ mode: "shared_workspace" });
  });

  it("captures the new assignee's default environment on reassignment", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const firstEnvironmentId = randomUUID();
    const secondEnvironmentId = randomUUID();
    const firstAgentId = randomUUID();
    const secondAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(environments).values([
      {
        id: firstEnvironmentId,
        companyId,
        name: "QA SSH",
        driver: "ssh",
        status: "active",
        config: {},
      },
      {
        id: secondEnvironmentId,
        companyId,
        name: "QA E2B",
        driver: "sandbox",
        status: "active",
        config: { provider: "e2b" },
      },
    ]);

    await db.insert(agents).values([
      {
        id: firstAgentId,
        companyId,
        name: "QA SSH Codex",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        defaultEnvironmentId: firstEnvironmentId,
        permissions: {},
      },
      {
        id: secondAgentId,
        companyId,
        name: "QA E2B Codex",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        defaultEnvironmentId: secondEnvironmentId,
        permissions: {},
      },
    ]);

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: "shared_workspace",
        allowIssueOverride: true,
        defaultProjectWorkspaceId: projectWorkspaceId,
      },
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
    });

    const created = await svc.create(companyId, {
      projectId,
      assigneeAgentId: firstAgentId,
      title: "Environment matrix: ssh / codex_local",
      status: "todo",
      priority: "medium",
    });

    expect(created.executionWorkspaceSettings).toMatchObject({
      environmentId: firstEnvironmentId,
    });

    const reassigned = await svc.update(created.id, {
      assigneeAgentId: secondAgentId,
    });

    expect(reassigned).not.toBeNull();
    expect(reassigned!.executionWorkspaceSettings).toMatchObject({
      environmentId: secondEnvironmentId,
    });
  });

  it("preserves an operator-set environmentId across reassignment", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const firstEnvironmentId = randomUUID();
    const secondEnvironmentId = randomUUID();
    const operatorEnvironmentId = randomUUID();
    const firstAgentId = randomUUID();
    const secondAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(environments).values([
      { id: firstEnvironmentId, companyId, name: "Env 1", driver: "ssh", status: "active", config: {} },
      { id: secondEnvironmentId, companyId, name: "Env 2", driver: "sandbox", status: "active", config: { provider: "e2b" } },
      { id: operatorEnvironmentId, companyId, name: "Operator pick", driver: "ssh", status: "active", config: {} },
    ]);

    await db.insert(agents).values([
      {
        id: firstAgentId, companyId, name: "First agent", role: "engineer", status: "active",
        adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {},
        defaultEnvironmentId: firstEnvironmentId, permissions: {},
      },
      {
        id: secondAgentId, companyId, name: "Second agent", role: "engineer", status: "active",
        adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {},
        defaultEnvironmentId: secondEnvironmentId, permissions: {},
      },
    ]);

    await db.insert(projects).values({
      id: projectId, companyId, name: "Workspace project", status: "in_progress",
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: "shared_workspace",
        allowIssueOverride: true,
        defaultProjectWorkspaceId: projectWorkspaceId,
      },
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId, companyId, projectId, name: "Primary workspace", isPrimary: true,
    });

    const created = await svc.create(companyId, {
      projectId,
      assigneeAgentId: firstAgentId,
      title: "Operator overrides env then reassigns",
      status: "todo",
      priority: "medium",
    });

    // Operator explicitly overrides the environmentId in a separate update.
    const overridden = await svc.update(created.id, {
      executionWorkspaceSettings: {
        mode: "shared_workspace",
        environmentId: operatorEnvironmentId,
      },
    });
    expect(overridden!.executionWorkspaceSettings).toMatchObject({
      environmentId: operatorEnvironmentId,
    });

    // A subsequent reassignment-only update must NOT overwrite the operator's
    // explicit choice with the new assignee's default.
    const reassigned = await svc.update(created.id, {
      assigneeAgentId: secondAgentId,
    });
    expect(reassigned!.executionWorkspaceSettings).toMatchObject({
      environmentId: operatorEnvironmentId,
    });
  });

  it("keeps explicit workspace fields instead of inheriting the parent linkage", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const parentIssueId = randomUUID();
    const parentProjectWorkspaceId = randomUUID();
    const parentExecutionWorkspaceId = randomUUID();
    const explicitProjectWorkspaceId = randomUUID();
    const explicitExecutionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values([
      {
        id: parentProjectWorkspaceId,
        companyId,
        projectId,
        name: "Parent workspace",
      },
      {
        id: explicitProjectWorkspaceId,
        companyId,
        projectId,
        name: "Explicit workspace",
      },
    ]);

    await db.insert(executionWorkspaces).values([
      {
        id: parentExecutionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId: parentProjectWorkspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Parent worktree",
        status: "active",
        providerType: "git_worktree",
      },
      {
        id: explicitExecutionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId: explicitProjectWorkspaceId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "Explicit shared workspace",
        status: "active",
        providerType: "local_fs",
      },
    ]);

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      projectWorkspaceId: parentProjectWorkspaceId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId: parentExecutionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
      },
    });

    const child = await svc.create(companyId, {
      parentId: parentIssueId,
      projectId,
      title: "Child issue",
      projectWorkspaceId: explicitProjectWorkspaceId,
      executionWorkspaceId: explicitExecutionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "shared_workspace",
      },
    });

    expect(child.projectWorkspaceId).toBe(explicitProjectWorkspaceId);
    expect(child.executionWorkspaceId).toBe(explicitExecutionWorkspaceId);
    expect(child.executionWorkspacePreference).toBe("reuse_existing");
    expect(child.executionWorkspaceSettings).toEqual({
      mode: "shared_workspace",
    });
  });

  it("inherits workspace linkage from an explicit source issue without creating a parent-child relationship", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const sourceIssueId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "operator_branch",
      strategyType: "git_worktree",
      name: "Operator branch",
      status: "active",
      providerType: "git_worktree",
    });

    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Source issue",
      status: "todo",
      priority: "medium",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "operator_branch",
      },
    });

    const followUp = await svc.create(companyId, {
      projectId,
      title: "Follow-up issue",
      inheritExecutionWorkspaceFromIssueId: sourceIssueId,
    });

    expect(followUp.parentId).toBeNull();
    expect(followUp.projectWorkspaceId).toBe(projectWorkspaceId);
    expect(followUp.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(followUp.executionWorkspacePreference).toBe("reuse_existing");
    expect(followUp.executionWorkspaceSettings).toEqual({
      mode: "operator_branch",
    });
  });
});

describeEmbeddedPostgres("issueService blockers and dependency wake readiness", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-blockers-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("persists blocked-by relations and exposes both blockedBy and blocks summaries", async () => {
    const companyId = randomUUID();
    const blockedAssigneeId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = await insertProject(db, companyId, "Dependencies");
    await db.insert(agents).values({
      id: blockedAssigneeId,
      companyId,
      name: "Blocked Owner",
    });

    const blockerId = randomUUID();
    const blockedId = randomUUID();
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        projectId,
        title: "Blocker",
        status: "todo",
        priority: "high",
      },
      {
        id: blockedId,
        companyId,
        projectId,
        title: "Blocked issue",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: blockedAssigneeId,
      },
    ]);

    await svc.update(blockedId, {
      blockedByIssueIds: [blockerId],
    });

    const blockerRelations = await svc.getRelationSummaries(blockerId);
    const blockedRelations = await svc.getRelationSummaries(blockedId);

    expect(blockerRelations.blocks.map((relation) => relation.id)).toEqual([blockedId]);
    expect(blockedRelations.blockedBy.map((relation) => relation.id)).toEqual([blockerId]);
  });

  it("rejects blocking cycles", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = await insertProject(db, companyId, "Cycle detection");

    const issueA = randomUUID();
    const issueB = randomUUID();
    await db.insert(issues).values([
      { id: issueA, companyId, projectId, title: "Issue A", status: "todo", priority: "medium" },
      { id: issueB, companyId, projectId, title: "Issue B", status: "todo", priority: "medium" },
    ]);

    await svc.update(issueA, { blockedByIssueIds: [issueB] });

    await expect(
      svc.update(issueB, { blockedByIssueIds: [issueA] }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("only returns dependents once every blocker is done", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = await insertProject(db, companyId, "Wakeable blockers");
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const blockerA = randomUUID();
    const blockerB = randomUUID();
    const blockedIssueId = randomUUID();
    await db.insert(issues).values([
      { id: blockerA, companyId, projectId, title: "Blocker A", status: "done", priority: "medium" },
      { id: blockerB, companyId, projectId, title: "Blocker B", status: "todo", priority: "medium" },
      {
        id: blockedIssueId,
        companyId,
        projectId,
        title: "Blocked issue",
        status: "blocked",
        priority: "medium",
        assigneeAgentId,
      },
    ]);

    await svc.update(blockedIssueId, { blockedByIssueIds: [blockerA, blockerB] });

    expect(await svc.listWakeableBlockedDependents(blockerA)).toEqual([]);

    await svc.update(blockerB, { status: "done" });

    await expect(svc.listWakeableBlockedDependents(blockerA)).resolves.toEqual([
      expect.objectContaining({
        id: blockedIssueId,
        assigneeAgentId,
        blockerIssueIds: expect.arrayContaining([blockerA, blockerB]),
      }),
    ]);
  });

  it("reports dependency readiness for blocked issue chains", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = await insertProject(db, companyId, "Dependency readiness");

    const blockerId = randomUUID();
    const blockedId = randomUUID();
    await db.insert(issues).values([
      { id: blockerId, companyId, projectId, title: "Blocker", status: "todo", priority: "medium" },
      { id: blockedId, companyId, projectId, title: "Blocked", status: "todo", priority: "medium" },
    ]);
    await svc.update(blockedId, { blockedByIssueIds: [blockerId] });

    await expect(svc.getDependencyReadiness(blockedId)).resolves.toMatchObject({
      issueId: blockedId,
      blockerIssueIds: [blockerId],
      unresolvedBlockerIssueIds: [blockerId],
      unresolvedBlockerCount: 1,
      allBlockersDone: false,
      isDependencyReady: false,
    });

    await svc.update(blockerId, { status: "done" });

    await expect(svc.getDependencyReadiness(blockedId)).resolves.toMatchObject({
      issueId: blockedId,
      blockerIssueIds: [blockerId],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      allBlockersDone: true,
      isDependencyReady: true,
    });
  });

  it("returns unresolvedBlockerIssueIds ordered deterministically by blocker identifier", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = await insertProject(db, companyId, "Dependency order");

    const blockerAlpha = randomUUID();
    const blockerBravo = randomUUID();
    const blockerCharlie = randomUUID();
    const blockedId = randomUUID();

    // Insert blockers in non-alphabetical order to force the query's orderBy to do the work.
    await db.insert(issues).values([
      {
        id: blockerCharlie,
        companyId,
        projectId,
        identifier: "AIW-C-3",
        title: "Blocker Charlie",
        status: "todo",
        priority: "medium",
      },
      {
        id: blockerAlpha,
        companyId,
        projectId,
        identifier: "AIW-C-1",
        title: "Blocker Alpha",
        status: "todo",
        priority: "medium",
      },
      {
        id: blockerBravo,
        companyId,
        projectId,
        identifier: "AIW-C-2",
        title: "Blocker Bravo",
        status: "todo",
        priority: "medium",
      },
      {
        id: blockedId,
        companyId,
        projectId,
        identifier: "AIW-C-4",
        title: "Blocked",
        status: "todo",
        priority: "medium",
      },
    ]);
    await svc.update(blockedId, {
      blockedByIssueIds: [blockerBravo, blockerCharlie, blockerAlpha],
    });

    const readinessMap = await svc.listDependencyReadiness(companyId, [blockedId]);
    const readiness = readinessMap.get(blockedId);
    expect(readiness?.unresolvedBlockerIssueIds).toEqual([
      blockerAlpha,
      blockerBravo,
      blockerCharlie,
    ]);
    expect(readiness?.unresolvedBlockerCount).toBe(3);
  });

  it("rejects execution when unresolved blockers remain", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = await insertProject(db, companyId, "Execution blockers");
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const blockerId = randomUUID();
    const blockedId = randomUUID();
    await db.insert(issues).values([
      { id: blockerId, companyId, projectId, title: "Blocker", status: "todo", priority: "medium" },
      {
        id: blockedId,
        companyId,
        projectId,
        title: "Blocked",
        status: "todo",
        priority: "medium",
        assigneeAgentId,
      },
    ]);
    await svc.update(blockedId, { blockedByIssueIds: [blockerId] });

    await expect(
      svc.update(blockedId, { status: "in_progress" }),
    ).rejects.toMatchObject({ status: 422 });

    await expect(
      svc.checkout(blockedId, assigneeAgentId, ["todo", "blocked"], null),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("wakes parents only when all direct children are terminal", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = await insertProject(db, companyId, "Parent wake");
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const parentId = randomUUID();
    const childA = randomUUID();
    const childB = randomUUID();
    await db.insert(issues).values([
      {
        id: parentId,
        companyId,
        projectId,
        title: "Parent issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId,
      },
      {
        id: childA,
        companyId,
        projectId,
        parentId,
        title: "Child A",
        status: "done",
        priority: "medium",
      },
      {
        id: childB,
        companyId,
        projectId,
        parentId,
        title: "Child B",
        status: "blocked",
        priority: "medium",
      },
    ]);

    expect(await svc.getWakeableParentAfterChildCompletion(parentId)).toBeNull();

    await svc.update(childB, { status: "cancelled" });

    expect(await svc.getWakeableParentAfterChildCompletion(parentId)).toEqual({
      id: parentId,
      assigneeAgentId,
      childIssueIds: [childA, childB],
    });
  });

  it("rejects illegal status transitions while still allowing terminal reopen to todo", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = await insertProject(db, companyId, "Status transitions");

    const doneIssueId = randomUUID();
    const cancelledIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: doneIssueId,
        companyId,
        projectId,
        title: "Completed issue",
        status: "done",
        priority: "medium",
      },
      {
        id: cancelledIssueId,
        companyId,
        projectId,
        title: "Cancelled issue",
        status: "cancelled",
        priority: "medium",
      },
    ]);

    await expect(
      svc.update(doneIssueId, { status: "in_progress" }),
    ).rejects.toMatchObject({ status: 409 });

    await expect(
      svc.update(cancelledIssueId, { status: "blocked" }),
    ).rejects.toMatchObject({ status: 409 });

    await expect(svc.update(doneIssueId, { status: "todo" })).resolves.toMatchObject({
      id: doneIssueId,
      status: "todo",
    });
  });

  it("rejects checkout expectedStatuses outside the server allowlist", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = await insertProject(db, companyId, "Checkout validation");
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Checkout target",
      status: "todo",
      priority: "medium",
    });

    await expect(
      svc.checkout(issueId, assigneeAgentId, ["todo", "done"], null),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("release keeps terminal issues terminal and clears execution lock fields", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = await insertProject(db, companyId, "Release terminal");
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const issueId = randomUUID();
    const checkoutRunId = randomUUID();
    const executionRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      {
        id: checkoutRunId,
        companyId,
        agentId: assigneeAgentId,
        invocationSource: "assignment",
        status: "succeeded",
        contextSnapshot: { issueId },
      },
      {
        id: executionRunId,
        companyId,
        agentId: assigneeAgentId,
        invocationSource: "assignment",
        status: "succeeded",
        contextSnapshot: { issueId },
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Completed issue",
      status: "done",
      priority: "medium",
      assigneeAgentId,
      checkoutRunId,
      executionRunId,
      executionAgentNameKey: "codex-owner",
      executionLockedAt: new Date("2026-04-22T12:00:00.000Z"),
    });

    const released = await svc.release(issueId, assigneeAgentId, null);

    expect(released).toMatchObject({
      id: issueId,
      status: "done",
      assigneeAgentId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
      checkoutRunId: null,
    });

    await db.delete(heartbeatRuns);
  });

  it("release returns active issues to todo and clears execution lock fields", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const actorRunId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = await insertProject(db, companyId, "Release active");
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const issueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: actorRunId,
      companyId,
      agentId: assigneeAgentId,
      invocationSource: "assignment",
      status: "running",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Active issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId,
      checkoutRunId: actorRunId,
      executionRunId: actorRunId,
      executionAgentNameKey: "codex-owner",
      executionLockedAt: new Date("2026-04-22T12:00:00.000Z"),
    });

    const released = await svc.release(issueId, assigneeAgentId, actorRunId);

    expect(released).toMatchObject({
      id: issueId,
      status: "todo",
      assigneeAgentId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
      checkoutRunId: null,
    });

    await db.delete(heartbeatRuns);
  });

  it("release rejects a different run on a live execution lease and leaves the tuple intact", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const liveRunId = randomUUID();
    const otherRunId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = await insertProject(db, companyId, "Release live guard");
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: liveRunId,
        companyId,
        agentId: assigneeAgentId,
        invocationSource: "assignment",
        status: "running",
        contextSnapshot: {},
      },
      {
        id: otherRunId,
        companyId,
        agentId: assigneeAgentId,
        invocationSource: "assignment",
        status: "running",
        contextSnapshot: {},
      },
    ]);

    const issueId = randomUUID();
    const lockedAt = new Date("2026-04-22T12:00:00.000Z");
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Live lease guard",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId,
      checkoutRunId: liveRunId,
      executionRunId: liveRunId,
      executionAgentNameKey: "codex-owner",
      executionLockedAt: lockedAt,
    });

    await expect(svc.release(issueId, assigneeAgentId, otherRunId)).rejects.toMatchObject({
      status: 409,
    });

    const row = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      status: "in_progress",
      assigneeAgentId,
      checkoutRunId: liveRunId,
      executionRunId: liveRunId,
      executionAgentNameKey: "codex-owner",
      executionLockedAt: lockedAt,
    });

    await db.delete(heartbeatRuns);
  });

  it("checkout self-heals a stale executionRunId when the referenced run has ended", async () => {
    const companyId = randomUUID();
    const newAgentId = randomUUID();
    const staleRunId = randomUUID();
    const newRunId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = await insertProject(db, companyId, "Stale lock self-heal");
    await db.insert(agents).values({
      id: newAgentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: staleRunId,
        companyId,
        agentId: newAgentId,
        invocationSource: "assignment",
        status: "succeeded",
        contextSnapshot: {},
      },
      {
        id: newRunId,
        companyId,
        agentId: newAgentId,
        invocationSource: "assignment",
        status: "running",
        contextSnapshot: {},
      },
    ]);

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Trapped issue",
      status: "todo",
      priority: "medium",
      assigneeAgentId: null,
      checkoutRunId: null,
      executionRunId: staleRunId,
      executionAgentNameKey: "codex-owner",
      executionLockedAt: new Date("2026-04-22T12:00:00.000Z"),
    });

    const checkedOut = await svc.checkout(issueId, newAgentId, ["todo"], newRunId);

    expect(checkedOut).toMatchObject({
      id: issueId,
      status: "in_progress",
      assigneeAgentId: newAgentId,
      checkoutRunId: newRunId,
      executionRunId: newRunId,
    });

    await db.delete(heartbeatRuns);
  });

  it("checkout still 409s when executionRunId references a live running run", async () => {
    const companyId = randomUUID();
    const holderAgentId = randomUUID();
    const intruderAgentId = randomUUID();
    const liveRunId = randomUUID();
    const intruderRunId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = await insertProject(db, companyId, "Live lease defense");
    await db.insert(agents).values([
      {
        id: holderAgentId,
        companyId,
        name: "LockHolder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: intruderAgentId,
        companyId,
        name: "Intruder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        id: liveRunId,
        companyId,
        agentId: holderAgentId,
        invocationSource: "assignment",
        status: "running",
        contextSnapshot: {},
      },
      {
        id: intruderRunId,
        companyId,
        agentId: intruderAgentId,
        invocationSource: "assignment",
        status: "running",
        contextSnapshot: {},
      },
    ]);

    const issueId = randomUUID();
    const lockedAt = new Date("2026-04-22T12:00:00.000Z");
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Live lease",
      status: "todo",
      priority: "medium",
      assigneeAgentId: null,
      checkoutRunId: null,
      executionRunId: liveRunId,
      executionAgentNameKey: "lock-holder",
      executionLockedAt: lockedAt,
    });

    await expect(
      svc.checkout(issueId, intruderAgentId, ["todo"], intruderRunId),
    ).rejects.toMatchObject({ status: 409 });

    const row = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      status: "todo",
      assigneeAgentId: null,
      checkoutRunId: null,
      executionRunId: liveRunId,
      executionAgentNameKey: "lock-holder",
      executionLockedAt: lockedAt,
    });

    await db.delete(heartbeatRuns);
  });
});

describeEmbeddedPostgres("issueService.clearExecutionRunIfTerminal", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-execution-lock-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssueWithRun(status: string | null) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = status ? randomUUID() : null;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = await insertProject(db, companyId, "Execution lock cleanup");
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    if (runId) {
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status,
        invocationSource: "manual",
      });
    }
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Execution lock",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: runId,
      executionAgentNameKey: runId ? "codexcoder" : null,
      executionLockedAt: runId ? new Date() : null,
    });

    return { issueId, runId };
  }

  it("clears execution locks owned by terminal runs", async () => {
    const { issueId } = await seedIssueWithRun("failed");

    await expect(svc.clearExecutionRunIfTerminal(issueId)).resolves.toBe(true);

    const row = await db
      .select({
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });
  });

  it("does not clear execution locks owned by live runs", async () => {
    const { issueId, runId } = await seedIssueWithRun("running");

    await expect(svc.clearExecutionRunIfTerminal(issueId)).resolves.toBe(false);

    const row = await db
      .select({
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.executionRunId).toBe(runId);
    expect(row?.executionAgentNameKey).toBe("codexcoder");
    expect(row?.executionLockedAt).toBeInstanceOf(Date);
  });

  it("does not update issues without an execution lock", async () => {
    const { issueId } = await seedIssueWithRun(null);

    await expect(svc.clearExecutionRunIfTerminal(issueId)).resolves.toBe(false);

    const row = await db
      .select({ executionRunId: issues.executionRunId, executionLockedAt: issues.executionLockedAt })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ executionRunId: null, executionLockedAt: null });
  });
});

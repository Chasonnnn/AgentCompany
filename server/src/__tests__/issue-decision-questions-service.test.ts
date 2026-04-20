import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  issueDecisionQuestions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueDecisionQuestionService } from "../services/issue-decision-questions.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres decision question tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueDecisionQuestionService", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueDecisionQuestionService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-decision-questions-");
    db = createDb(tempDb.connectionString);
    svc = issueDecisionQuestionService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueDecisionQuestions);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue() {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `Q${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Scope the audit",
      status: "todo",
      priority: "high",
      identifier: "AIW-5",
      issueNumber: 5,
    });

    return { companyId, issueId };
  }

  async function seedQuestion() {
    const { companyId, issueId } = await seedIssue();
    const questionId = randomUUID();

    await db.insert(issueDecisionQuestions).values({
      id: questionId,
      companyId,
      issueId,
      target: "board",
      status: "open",
      blocking: true,
      title: "Pick the first audit slice",
      question: "Should the audit start with runtime or governance?",
      whyBlocked: "The execution plan depends on the initial slice.",
      recommendedOptions: [
        { key: "runtime", label: "Runtime", description: "Inspect execution and infra first." },
        { key: "governance", label: "Governance", description: "Inspect instructions and approvals first." },
      ],
      suggestedDefault: "runtime",
    });

    return { companyId, issueId, questionId };
  }

  it("stores the selected option label as the canonical answer text", async () => {
    const { questionId } = await seedQuestion();

    const result = await svc.answer(questionId, { selectedOptionKey: "runtime" }, { userId: "board-user" });

    expect(result.question.answer).toEqual({
      selectedOptionKey: "runtime",
      answer: "Runtime",
      note: null,
    });
  });

  it("rejects answers that select an option not present on the question", async () => {
    const { questionId } = await seedQuestion();

    await expect(
      svc.answer(questionId, { selectedOptionKey: "missing-option" }, { userId: "board-user" }),
    ).rejects.toMatchObject({
      status: 422,
      message: "Selected option is not available for this decision question",
    });
  });

  it("dismisses open questions with an empty payload", async () => {
    const { questionId } = await seedQuestion();

    const result = await svc.dismiss(questionId, {}, { userId: "board-user" });

    expect(result.question.status).toBe("dismissed");
    expect(result.question.answer).toBeNull();
  });
});

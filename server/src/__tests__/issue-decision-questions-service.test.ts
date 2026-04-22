import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  issueDecisionQuestions,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueContinuityService } from "../services/issue-continuity.ts";
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
  let continuitySvc!: ReturnType<typeof issueContinuityService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-decision-questions-");
    db = createDb(tempDb.connectionString);
    svc = issueDecisionQuestionService(db);
    continuitySvc = issueContinuityService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueDecisionQuestions);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue() {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const projectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `Q${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Decision questions",
      status: "in_progress",
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
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

  it("splits bundled multi-decision asks into separate structured questions on create", async () => {
    const { issueId } = await seedIssue();

    const result = await svc.create(
      issueId,
      {
        title: "AIW-5 scope lock: three open decisions (re-asked)",
        question:
          "Need a single board decision to lock scope on AIW-5 before `spec` is written (spec freezes at execution start). Three picks bundled below. **Decision A — Overlap with AIW-4.** 1. Re-audit end-to-end from scratch (treat AIW-5 as independent). 2. Re-verify only the AIW-4 critical/high findings against current state, then extend. 3. Extend into dimensions AIW-4 did not cover deeply (skills surface, run traceability, budget, instructions drift). **Decision B — Enterprise production-grade bar:** 1. *Paying-customer bar* — a paying enterprise could run a real project on Paperclip today without human escort. 2. *Internal-team bar* — our own team can ship real projects without constant CEO intervention. **Decision C — Remediation coupling:** 1. *Read-only audit* — findings only, no implicit commitment, no subtasks. 2. *Batch remediation plan* — audit ends with a prioritized remediation plan submitted as a single approval for batch go/no-go. Reply in any form (e.g. \"A2, B1, C2\") and I'll lock scope and start the spec.",
        blocking: true,
      },
      {},
    );

    const openQuestions = result.continuityBundle.decisionQuestions.filter((question) => question.status === "open");

    expect(result.question.title).toBe("AIW-5 scope lock: Overlap with AIW-4");
    expect(openQuestions).toHaveLength(3);
    expect(openQuestions.map((question) => question.title)).toEqual([
      "AIW-5 scope lock: Overlap with AIW-4",
      "AIW-5 scope lock: Enterprise production-grade bar",
      "AIW-5 scope lock: Remediation coupling",
    ]);
    expect(openQuestions[0]?.recommendedOptions.map((option) => option.label)).toEqual([
      "Re-audit end-to-end from scratch (treat AIW-5 as independent)",
      "Re-verify only the AIW-4 critical/high findings against current state, then extend",
      "Extend into dimensions AIW-4 did not cover deeply (skills surface, run traceability, budget, instructions drift)",
    ]);
  });

  it("auto-normalizes legacy bundled open questions when continuity is loaded", async () => {
    const { companyId, issueId } = await seedIssue();

    await db.insert(issueDecisionQuestions).values({
      companyId,
      issueId,
      target: "board",
      status: "open",
      blocking: true,
      title: "AIW-5 scope lock: three open decisions (re-asked)",
      question:
        "Need a single board decision to lock scope on AIW-5 before `spec` is written (spec freezes at execution start). Three picks bundled below. **Decision A — Overlap with AIW-4.** 1. Re-audit end-to-end from scratch (treat AIW-5 as independent). 2. Re-verify only the AIW-4 critical/high findings against current state, then extend. **Decision B — Enterprise production-grade bar:** 1. *Paying-customer bar* — a paying enterprise could run a real project on Paperclip today without human escort. 2. *Internal-team bar* — our own team can ship real projects without constant CEO intervention. **Decision C — Remediation coupling:** 1. *Read-only audit* — findings only, no implicit commitment, no subtasks. 2. *Batch remediation plan* — audit ends with a prioritized remediation plan submitted as a single approval for batch go/no-go.",
      recommendedOptions: [],
      suggestedDefault: null,
    });

    const continuity = await continuitySvc.getIssueContinuity(issueId);
    const openQuestions = continuity.continuityBundle.decisionQuestions.filter((question) => question.status === "open");
    const dismissedQuestions = continuity.continuityBundle.decisionQuestions.filter((question) => question.status === "dismissed");

    expect(openQuestions).toHaveLength(3);
    expect(dismissedQuestions).toHaveLength(1);
    expect(dismissedQuestions[0]?.answer?.answer).toContain("Automatically split into 3 structured decision questions");
    expect(openQuestions.map((question) => question.title)).toEqual([
      "AIW-5 scope lock: Overlap with AIW-4",
      "AIW-5 scope lock: Enterprise production-grade bar",
      "AIW-5 scope lock: Remediation coupling",
    ]);
  });
});

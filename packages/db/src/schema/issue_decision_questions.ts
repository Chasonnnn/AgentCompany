import { pgTable, uuid, text, timestamp, boolean, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";
import { approvals } from "./approvals.js";

export const issueDecisionQuestions = pgTable(
  "issue_decision_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    target: text("target").notNull().default("board"),
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    requestedByUserId: text("requested_by_user_id"),
    status: text("status").notNull().default("open"),
    blocking: boolean("blocking").notNull().default(true),
    title: text("title").notNull(),
    question: text("question").notNull(),
    whyBlocked: text("why_blocked"),
    recommendedOptions: jsonb("recommended_options").$type<Record<string, unknown>[]>().notNull().default([]),
    suggestedDefault: text("suggested_default"),
    answer: jsonb("answer").$type<Record<string, unknown> | null>(),
    answeredByUserId: text("answered_by_user_id"),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    linkedApprovalId: uuid("linked_approval_id").references(() => approvals.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueStatusIdx: index("issue_decision_questions_company_issue_status_idx").on(
      table.companyId,
      table.issueId,
      table.status,
    ),
    companyStatusIdx: index("issue_decision_questions_company_status_idx").on(table.companyId, table.status),
    requestedByAgentIdx: index("issue_decision_questions_requested_by_agent_idx").on(table.requestedByAgentId),
    linkedApprovalIdx: index("issue_decision_questions_linked_approval_idx").on(table.linkedApprovalId),
  }),
);

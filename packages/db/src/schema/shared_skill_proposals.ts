import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sharedSkills } from "./shared_skills.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";

export const sharedSkillProposals = pgTable(
  "shared_skill_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sharedSkillId: uuid("shared_skill_id").notNull().references(() => sharedSkills.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    proposedByAgentId: uuid("proposed_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    proposedByUserId: text("proposed_by_user_id").references(() => authUsers.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("pending"),
    summary: text("summary").notNull(),
    rationale: text("rationale").notNull(),
    baseMirrorDigest: text("base_mirror_digest"),
    baseSourceDigest: text("base_source_digest"),
    proposalFingerprint: text("proposal_fingerprint").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    decisionNote: text("decision_note"),
    decidedByUserId: text("decided_by_user_id").references(() => authUsers.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    appliedMirrorDigest: text("applied_mirror_digest"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sharedSkillStatusIdx: index("shared_skill_proposals_shared_skill_status_idx").on(
      table.sharedSkillId,
      table.status,
      table.createdAt,
    ),
    sharedSkillRunIdx: index("shared_skill_proposals_shared_skill_run_idx").on(table.sharedSkillId, table.runId),
    fingerprintStatusUniqueIdx: uniqueIndex("shared_skill_proposals_fingerprint_status_idx").on(
      table.proposalFingerprint,
      table.status,
    ),
  }),
);

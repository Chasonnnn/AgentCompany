import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex, boolean } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    provider: text("provider").notNull(),
    objectKey: text("object_key").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    originalFilename: text("original_filename"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id),
    createdByUserId: text("created_by_user_id"),
    scanStatus: text("scan_status").notNull().default("pending_scan"),
    scanProvider: text("scan_provider"),
    scanCompletedAt: timestamp("scan_completed_at", { withTimezone: true }),
    quarantinedAt: timestamp("quarantined_at", { withTimezone: true }),
    quarantineReason: text("quarantine_reason"),
    retentionClass: text("retention_class").notNull().default("evidence"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    legalHold: boolean("legal_hold").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("assets_company_created_idx").on(table.companyId, table.createdAt),
    companyProviderIdx: index("assets_company_provider_idx").on(table.companyId, table.provider),
    companyObjectKeyUq: uniqueIndex("assets_company_object_key_uq").on(table.companyId, table.objectKey),
  }),
);

import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { documents } from "./documents.js";

export const teamDocuments = pgTable(
  "team_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    departmentKey: text("department_key").notNull(),
    departmentName: text("department_name").notNull().default(""),
    key: text("key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyDepartmentKeyUq: uniqueIndex("team_documents_company_department_key_uq").on(
      table.companyId,
      table.departmentKey,
      table.departmentName,
      table.key,
    ),
    documentUq: uniqueIndex("team_documents_document_uq").on(table.documentId),
    companyDepartmentUpdatedIdx: index("team_documents_company_department_updated_idx").on(
      table.companyId,
      table.departmentKey,
      table.departmentName,
      table.updatedAt,
    ),
  }),
);

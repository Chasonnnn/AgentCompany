import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";

export const sharedSkills = pgTable(
  "shared_skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    markdown: text("markdown").notNull(),
    fileInventory: jsonb("file_inventory").$type<Array<Record<string, unknown>>>().notNull().default([]),
    trustLevel: text("trust_level").notNull().default("markdown_only"),
    compatibility: text("compatibility").notNull().default("compatible"),
    sourceRoot: text("source_root").notNull(),
    sourcePath: text("source_path").notNull(),
    sourceDigest: text("source_digest"),
    lastMirroredSourceDigest: text("last_mirrored_source_digest"),
    mirrorDigest: text("mirror_digest"),
    lastAppliedMirrorDigest: text("last_applied_mirror_digest"),
    mirrorState: text("mirror_state").notNull().default("pristine"),
    sourceDriftState: text("source_drift_state").notNull().default("in_sync"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    keyUniqueIdx: uniqueIndex("shared_skills_key_idx").on(table.key),
    sourceRootPathUniqueIdx: uniqueIndex("shared_skills_source_root_path_idx").on(table.sourceRoot, table.sourcePath),
    nameIdx: index("shared_skills_name_idx").on(table.name),
    driftIdx: index("shared_skills_drift_idx").on(table.sourceDriftState, table.updatedAt),
  }),
);

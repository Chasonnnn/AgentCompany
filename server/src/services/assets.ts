import { and, eq, isNull, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assets } from "@paperclipai/db";

export function assetService(db: Db) {
  return {
    create: (companyId: string, data: Omit<typeof assets.$inferInsert, "companyId">) =>
      db
        .insert(assets)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]),

    update: (id: string, patch: Partial<typeof assets.$inferInsert>) =>
      db
        .update(assets)
        .set({
          ...patch,
          updatedAt: new Date(),
        })
        .where(eq(assets.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    getById: (id: string) =>
      db
        .select()
        .from(assets)
        .where(eq(assets.id, id))
        .then((rows) => rows[0] ?? null),

    listRetentionCandidates: (now: Date) =>
      db
        .select()
        .from(assets)
        .where(
          and(
            lte(assets.expiresAt, now),
            eq(assets.legalHold, false),
            isNull(assets.deletedAt),
          ),
        ),
  };
}

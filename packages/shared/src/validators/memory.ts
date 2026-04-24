import { z } from "zod";

export const memoryScopeSchema = z.enum(["agent", "company"]);
export const memoryHealthStatusSchema = z.enum(["ok", "warning", "over_limit"]);

export const upsertMemoryFileSchema = z.object({
  path: z.string().trim().min(1),
  content: z.string(),
}).strict();

export type UpsertMemoryFile = z.infer<typeof upsertMemoryFileSchema>;

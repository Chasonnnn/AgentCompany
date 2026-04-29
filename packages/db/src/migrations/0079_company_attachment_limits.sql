ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "attachment_max_bytes" integer DEFAULT 10485760 NOT NULL;
--> statement-breakpoint

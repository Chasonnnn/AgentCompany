CREATE TABLE IF NOT EXISTS "issue_thread_interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"continuation_policy" text DEFAULT 'wake_assignee' NOT NULL,
	"idempotency_key" text,
	"source_comment_id" uuid,
	"source_run_id" uuid,
	"title" text,
	"summary" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"resolved_by_agent_id" uuid,
	"resolved_by_user_id" text,
	"payload" jsonb NOT NULL,
	"result" jsonb,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "monitor_next_check_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "monitor_wake_requested_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "monitor_last_triggered_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "monitor_attempt_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "monitor_notes" text;
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "monitor_scheduled_by" text;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_source_comment_id_issue_comments_id_fk" FOREIGN KEY ("source_comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_source_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_resolved_by_agent_id_agents_id_fk" FOREIGN KEY ("resolved_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_thread_interactions_issue_idx" ON "issue_thread_interactions" USING btree ("issue_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_thread_interactions_company_issue_created_at_idx" ON "issue_thread_interactions" USING btree ("company_id","issue_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_thread_interactions_company_issue_status_idx" ON "issue_thread_interactions" USING btree ("company_id","issue_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_thread_interactions_company_issue_idempotency_uq" ON "issue_thread_interactions" USING btree ("company_id","issue_id","idempotency_key") WHERE "issue_thread_interactions"."idempotency_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_thread_interactions_source_comment_idx" ON "issue_thread_interactions" USING btree ("source_comment_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_company_monitor_due_idx" ON "issues" USING btree ("company_id","monitor_next_check_at");

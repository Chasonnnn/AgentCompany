CREATE TABLE "shared_skill_proposal_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"author_agent_id" uuid,
	"author_user_id" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shared_skill_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shared_skill_id" uuid NOT NULL,
	"company_id" uuid,
	"issue_id" uuid,
	"run_id" uuid,
	"proposed_by_agent_id" uuid,
	"proposed_by_user_id" text,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"summary" text NOT NULL,
	"rationale" text NOT NULL,
	"base_mirror_digest" text,
	"base_source_digest" text,
	"proposal_fingerprint" text NOT NULL,
	"payload" jsonb NOT NULL,
	"decision_note" text,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"applied_mirror_digest" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shared_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"markdown" text NOT NULL,
	"file_inventory" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"trust_level" text DEFAULT 'markdown_only' NOT NULL,
	"compatibility" text DEFAULT 'compatible' NOT NULL,
	"source_root" text NOT NULL,
	"source_path" text NOT NULL,
	"source_digest" text,
	"last_mirrored_source_digest" text,
	"mirror_digest" text,
	"last_applied_mirror_digest" text,
	"mirror_state" text DEFAULT 'pristine' NOT NULL,
	"source_drift_state" text DEFAULT 'in_sync' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN "shared_skill_id" uuid;--> statement-breakpoint
ALTER TABLE "shared_skill_proposal_comments" ADD CONSTRAINT "shared_skill_proposal_comments_proposal_id_shared_skill_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."shared_skill_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_skill_proposal_comments" ADD CONSTRAINT "shared_skill_proposal_comments_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_skill_proposal_comments" ADD CONSTRAINT "shared_skill_proposal_comments_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_skill_proposals" ADD CONSTRAINT "shared_skill_proposals_shared_skill_id_shared_skills_id_fk" FOREIGN KEY ("shared_skill_id") REFERENCES "public"."shared_skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_skill_proposals" ADD CONSTRAINT "shared_skill_proposals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_skill_proposals" ADD CONSTRAINT "shared_skill_proposals_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_skill_proposals" ADD CONSTRAINT "shared_skill_proposals_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_skill_proposals" ADD CONSTRAINT "shared_skill_proposals_proposed_by_agent_id_agents_id_fk" FOREIGN KEY ("proposed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_skill_proposals" ADD CONSTRAINT "shared_skill_proposals_proposed_by_user_id_user_id_fk" FOREIGN KEY ("proposed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_skill_proposals" ADD CONSTRAINT "shared_skill_proposals_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shared_skill_proposal_comments_proposal_idx" ON "shared_skill_proposal_comments" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "shared_skill_proposal_comments_proposal_created_idx" ON "shared_skill_proposal_comments" USING btree ("proposal_id","created_at");--> statement-breakpoint
CREATE INDEX "shared_skill_proposals_shared_skill_status_idx" ON "shared_skill_proposals" USING btree ("shared_skill_id","status","created_at");--> statement-breakpoint
CREATE INDEX "shared_skill_proposals_shared_skill_run_idx" ON "shared_skill_proposals" USING btree ("shared_skill_id","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shared_skill_proposals_fingerprint_status_idx" ON "shared_skill_proposals" USING btree ("proposal_fingerprint","status");--> statement-breakpoint
CREATE UNIQUE INDEX "shared_skills_key_idx" ON "shared_skills" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "shared_skills_source_root_path_idx" ON "shared_skills" USING btree ("source_root","source_path");--> statement-breakpoint
CREATE INDEX "shared_skills_name_idx" ON "shared_skills" USING btree ("name");--> statement-breakpoint
CREATE INDEX "shared_skills_drift_idx" ON "shared_skills" USING btree ("source_drift_state","updated_at");--> statement-breakpoint
ALTER TABLE "company_skills" ADD CONSTRAINT "company_skills_shared_skill_id_shared_skills_id_fk" FOREIGN KEY ("shared_skill_id") REFERENCES "public"."shared_skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

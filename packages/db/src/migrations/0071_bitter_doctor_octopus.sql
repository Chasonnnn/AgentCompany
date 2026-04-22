CREATE TABLE "budget_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"issue_id" uuid,
	"project_id" uuid,
	"heartbeat_run_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid,
	"metric" text DEFAULT 'billed_cents' NOT NULL,
	"reserved_cents" integer DEFAULT 0 NOT NULL,
	"actual_cost_event_id" uuid,
	"status" text DEFAULT 'reserved' NOT NULL,
	"retry_disposition" text DEFAULT 'charge_full' NOT NULL,
	"reason" text,
	"metadata_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reconciled_at" timestamp with time zone,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "scan_status" text DEFAULT 'pending_scan' NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "scan_provider" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "scan_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "quarantined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "quarantine_reason" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "retention_class" text DEFAULT 'evidence' NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "legal_hold" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN "manifest_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN "identity_digest" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN "content_digest" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN "source_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN "verification_state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN "compatibility_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN "retry_disposition" text DEFAULT 'charge_full' NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD COLUMN "cleanup_state" text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD COLUMN "cleanup_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD COLUMN "last_cleanup_error" text;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD COLUMN "next_cleanup_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD COLUMN "reconcile_state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD COLUMN "last_reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "finance_events" ADD COLUMN "retry_disposition" text DEFAULT 'charge_full' NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "advisor_kind" text;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "advisor_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_service_engagements" ADD COLUMN "advisor_kind" text;--> statement-breakpoint
ALTER TABLE "shared_service_engagements" ADD COLUMN "advisor_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_skills" ADD COLUMN "manifest_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_skills" ADD COLUMN "identity_digest" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_skills" ADD COLUMN "content_digest" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_skills" ADD COLUMN "source_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shared_skills" ADD COLUMN "verification_state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_skills" ADD COLUMN "compatibility_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_reservations_company_run_idx" ON "budget_reservations" USING btree ("company_id","heartbeat_run_id");--> statement-breakpoint
CREATE INDEX "budget_reservations_company_scope_idx" ON "budget_reservations" USING btree ("company_id","scope_type","scope_id","status");--> statement-breakpoint
CREATE INDEX "budget_reservations_company_status_idx" ON "budget_reservations" USING btree ("company_id","status","created_at");
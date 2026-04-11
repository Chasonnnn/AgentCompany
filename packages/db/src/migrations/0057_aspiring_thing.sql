CREATE TABLE "portfolio_clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"summary" text,
	"status" text DEFAULT 'active' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"executive_sponsor_agent_id" uuid,
	"portfolio_director_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shared_service_engagement_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shared_service_engagements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"target_project_id" uuid NOT NULL,
	"service_area_key" text NOT NULL,
	"service_area_label" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"requested_by_agent_id" uuid,
	"requested_by_user_id" text,
	"approved_by_agent_id" uuid,
	"approved_by_user_id" text,
	"closed_by_agent_id" uuid,
	"closed_by_user_id" text,
	"approved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"outcome_summary" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_project_scopes" ADD COLUMN "team_function_key" text;--> statement-breakpoint
ALTER TABLE "agent_project_scopes" ADD COLUMN "team_function_label" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "portfolio_cluster_id" uuid;--> statement-breakpoint
ALTER TABLE "portfolio_clusters" ADD CONSTRAINT "portfolio_clusters_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_clusters" ADD CONSTRAINT "portfolio_clusters_executive_sponsor_agent_id_agents_id_fk" FOREIGN KEY ("executive_sponsor_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_clusters" ADD CONSTRAINT "portfolio_clusters_portfolio_director_agent_id_agents_id_fk" FOREIGN KEY ("portfolio_director_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_service_engagement_assignments" ADD CONSTRAINT "shared_service_engagement_assignments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_service_engagement_assignments" ADD CONSTRAINT "shared_service_engagement_assignments_engagement_id_shared_service_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."shared_service_engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_service_engagement_assignments" ADD CONSTRAINT "shared_service_engagement_assignments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_service_engagements" ADD CONSTRAINT "shared_service_engagements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_service_engagements" ADD CONSTRAINT "shared_service_engagements_target_project_id_projects_id_fk" FOREIGN KEY ("target_project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_service_engagements" ADD CONSTRAINT "shared_service_engagements_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_service_engagements" ADD CONSTRAINT "shared_service_engagements_approved_by_agent_id_agents_id_fk" FOREIGN KEY ("approved_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_service_engagements" ADD CONSTRAINT "shared_service_engagements_closed_by_agent_id_agents_id_fk" FOREIGN KEY ("closed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portfolio_clusters_company_idx" ON "portfolio_clusters" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "portfolio_clusters_company_slug_uq" ON "portfolio_clusters" USING btree ("company_id","slug");--> statement-breakpoint
CREATE INDEX "shared_service_eng_assignments_company_engagement_idx" ON "shared_service_engagement_assignments" USING btree ("company_id","engagement_id");--> statement-breakpoint
CREATE INDEX "shared_service_eng_assignments_agent_idx" ON "shared_service_engagement_assignments" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shared_service_eng_assignments_engagement_agent_uq" ON "shared_service_engagement_assignments" USING btree ("engagement_id","agent_id");--> statement-breakpoint
CREATE INDEX "shared_service_engagements_company_idx" ON "shared_service_engagements" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "shared_service_engagements_project_idx" ON "shared_service_engagements" USING btree ("target_project_id");--> statement-breakpoint
CREATE INDEX "shared_service_engagements_status_idx" ON "shared_service_engagements" USING btree ("company_id","status");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_portfolio_cluster_id_portfolio_clusters_id_fk" FOREIGN KEY ("portfolio_cluster_id") REFERENCES "public"."portfolio_clusters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "projects_company_cluster_idx" ON "projects" USING btree ("company_id","portfolio_cluster_id");

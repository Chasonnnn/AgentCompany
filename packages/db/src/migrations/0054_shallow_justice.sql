CREATE TABLE "agent_project_scopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"scope_mode" text NOT NULL,
	"project_role" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"workstream_key" text,
	"workstream_label" text,
	"granted_by_principal_type" text,
	"granted_by_principal_id" text,
	"active_from" timestamp with time zone DEFAULT now() NOT NULL,
	"active_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_secondary_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"related_agent_id" uuid NOT NULL,
	"relationship_type" text NOT NULL,
	"created_by_principal_type" text,
	"created_by_principal_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_template_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text DEFAULT 'general' NOT NULL,
	"operating_class" text DEFAULT 'worker' NOT NULL,
	"capability_profile_key" text DEFAULT 'worker' NOT NULL,
	"archetype_key" text DEFAULT 'general' NOT NULL,
	"metadata" jsonb,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "template_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "template_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "operating_class" text DEFAULT 'worker' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "capability_profile_key" text DEFAULT 'worker' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "archetype_key" text DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "requested_by_principal_type" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "requested_by_principal_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "requested_for_project_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "requested_reason" text;--> statement-breakpoint
UPDATE "agents"
SET
  "operating_class" = CASE
    WHEN "role" IN ('ceo', 'cto', 'cfo', 'cmo', 'coo') THEN 'executive'
    WHEN "org_level" = 'director' THEN 'project_leadership'
    ELSE 'worker'
  END,
  "capability_profile_key" = CASE
    WHEN "role" = 'ceo' THEN 'legacy_ceo'
    WHEN "role" IN ('cto', 'cfo', 'cmo', 'coo') THEN 'executive_specialist'
    WHEN "org_level" = 'director' THEN 'project_lead'
    ELSE 'worker'
  END,
  "archetype_key" = CASE
    WHEN "role" = 'ceo' THEN 'chief_executive'
    WHEN "role" = 'cto' THEN 'chief_technology_officer'
    WHEN "role" = 'cfo' THEN 'chief_finance_officer'
    WHEN "role" = 'cmo' THEN 'chief_marketing_officer'
    WHEN "role" = 'coo' THEN 'chief_of_staff'
    WHEN "role" = 'pm' THEN 'product_manager'
    WHEN "role" = 'qa' THEN 'qa_engineer'
    WHEN "role" = 'devops' THEN 'devops_engineer'
    WHEN "role" = 'designer' THEN 'designer'
    WHEN "role" = 'researcher' THEN 'researcher'
    WHEN "role" = 'engineer' THEN 'engineer'
    ELSE 'general'
  END;
--> statement-breakpoint
CREATE TEMP TABLE "agent_template_backfill_map" (
  "agent_id" uuid NOT NULL,
  "template_id" uuid NOT NULL,
  "revision_id" uuid NOT NULL
);
--> statement-breakpoint
INSERT INTO "agent_template_backfill_map" ("agent_id", "template_id", "revision_id")
SELECT "id", gen_random_uuid(), gen_random_uuid()
FROM "agents";
--> statement-breakpoint
INSERT INTO "agent_templates" (
  "id",
  "company_id",
  "name",
  "role",
  "operating_class",
  "capability_profile_key",
  "archetype_key",
  "metadata",
  "archived_at",
  "created_at",
  "updated_at"
)
SELECT
  m."template_id",
  a."company_id",
  a."name",
  a."role",
  a."operating_class",
  a."capability_profile_key",
  a."archetype_key",
  a."metadata",
  CASE WHEN a."status" = 'terminated' THEN a."updated_at" ELSE NULL END,
  a."created_at",
  a."updated_at"
FROM "agent_template_backfill_map" m
INNER JOIN "agents" a ON a."id" = m."agent_id";
--> statement-breakpoint
INSERT INTO "agent_template_revisions" (
  "id",
  "company_id",
  "template_id",
  "revision_number",
  "snapshot",
  "created_by_agent_id",
  "created_by_user_id",
  "created_at"
)
SELECT
  m."revision_id",
  a."company_id",
  m."template_id",
  1,
  jsonb_build_object(
    'name', a."name",
    'role', a."role",
    'title', a."title",
    'icon', a."icon",
    'reportsTo', a."reports_to",
    'orgLevel', a."org_level",
    'operatingClass', a."operating_class",
    'capabilityProfileKey', a."capability_profile_key",
    'archetypeKey', a."archetype_key",
    'departmentKey', a."department_key",
    'departmentName', a."department_name",
    'capabilities', a."capabilities",
    'adapterType', a."adapter_type",
    'adapterConfig', COALESCE(a."adapter_config", '{}'::jsonb),
    'runtimeConfig', COALESCE(a."runtime_config", '{}'::jsonb),
    'budgetMonthlyCents', a."budget_monthly_cents",
    'metadata', a."metadata"
  ),
  NULL,
  NULL,
  a."created_at"
FROM "agent_template_backfill_map" m
INNER JOIN "agents" a ON a."id" = m."agent_id";
--> statement-breakpoint
UPDATE "agents" a
SET
  "template_id" = m."template_id",
  "template_revision_id" = m."revision_id"
FROM "agent_template_backfill_map" m
WHERE a."id" = m."agent_id";
--> statement-breakpoint
DROP TABLE "agent_template_backfill_map";
--> statement-breakpoint
INSERT INTO "agent_project_scopes" (
  "company_id",
  "agent_id",
  "project_id",
  "scope_mode",
  "project_role",
  "is_primary",
  "active_from",
  "created_at",
  "updated_at"
)
SELECT
  p."company_id",
  p."lead_agent_id",
  p."id",
  'leadership_summary',
  'director',
  true,
  p."created_at",
  p."created_at",
  p."updated_at"
FROM "projects" p
WHERE p."lead_agent_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "agent_project_scopes" s
    WHERE s."agent_id" = p."lead_agent_id"
      AND s."project_id" = p."id"
      AND s."scope_mode" IN ('leadership_summary', 'leadership_raw')
  );
--> statement-breakpoint
WITH "single_project_workers" AS (
  SELECT
    i."company_id",
    i."assignee_agent_id" AS "agent_id",
    MIN(i."project_id"::text)::uuid AS "project_id",
    MIN(i."created_at") AS "first_seen_at",
    COUNT(DISTINCT i."project_id") AS "project_count"
  FROM "issues" i
  INNER JOIN "agents" a ON a."id" = i."assignee_agent_id"
  WHERE i."assignee_agent_id" IS NOT NULL
    AND i."project_id" IS NOT NULL
    AND i."hidden_at" IS NULL
    AND a."operating_class" = 'worker'
  GROUP BY i."company_id", i."assignee_agent_id"
)
INSERT INTO "agent_project_scopes" (
  "company_id",
  "agent_id",
  "project_id",
  "scope_mode",
  "project_role",
  "is_primary",
  "active_from",
  "created_at",
  "updated_at"
)
SELECT
  w."company_id",
  w."agent_id",
  w."project_id",
  'execution',
  'worker',
  true,
  w."first_seen_at",
  w."first_seen_at",
  NOW()
FROM "single_project_workers" w
WHERE w."project_count" = 1
  AND NOT EXISTS (
    SELECT 1
    FROM "agent_project_scopes" s
    WHERE s."agent_id" = w."agent_id"
      AND s."project_id" = w."project_id"
      AND s."scope_mode" = 'execution'
  );
--> statement-breakpoint
ALTER TABLE "agent_project_scopes" ADD CONSTRAINT "agent_project_scopes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_project_scopes" ADD CONSTRAINT "agent_project_scopes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_project_scopes" ADD CONSTRAINT "agent_project_scopes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_secondary_relationships" ADD CONSTRAINT "agent_secondary_relationships_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_secondary_relationships" ADD CONSTRAINT "agent_secondary_relationships_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_secondary_relationships" ADD CONSTRAINT "agent_secondary_relationships_related_agent_id_agents_id_fk" FOREIGN KEY ("related_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_template_revisions" ADD CONSTRAINT "agent_template_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_template_revisions" ADD CONSTRAINT "agent_template_revisions_template_id_agent_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."agent_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_template_revisions" ADD CONSTRAINT "agent_template_revisions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_templates" ADD CONSTRAINT "agent_templates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_project_scopes_company_agent_idx" ON "agent_project_scopes" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE INDEX "agent_project_scopes_company_project_idx" ON "agent_project_scopes" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "agent_project_scopes_agent_project_mode_idx" ON "agent_project_scopes" USING btree ("agent_id","project_id","scope_mode");--> statement-breakpoint
CREATE INDEX "agent_secondary_relationships_company_agent_relationship_idx" ON "agent_secondary_relationships" USING btree ("company_id","agent_id","relationship_type");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_template_revisions_template_revision_idx" ON "agent_template_revisions" USING btree ("template_id","revision_number");--> statement-breakpoint
CREATE INDEX "agent_template_revisions_company_template_idx" ON "agent_template_revisions" USING btree ("company_id","template_id");--> statement-breakpoint
CREATE INDEX "agent_templates_company_archived_idx" ON "agent_templates" USING btree ("company_id","archived_at");--> statement-breakpoint
CREATE INDEX "agents_company_template_idx" ON "agents" USING btree ("company_id","template_id");

CREATE TABLE "conference_room_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"conference_room_id" uuid NOT NULL,
	"approval_id" uuid NOT NULL,
	"linked_by_agent_id" uuid,
	"linked_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conference_room_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"conference_room_id" uuid NOT NULL,
	"author_agent_id" uuid,
	"author_user_id" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conference_room_issue_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"conference_room_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"linked_by_agent_id" uuid,
	"linked_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conference_room_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"conference_room_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"added_by_agent_id" uuid,
	"added_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conference_rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"agenda" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "org_level" text DEFAULT 'staff' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "department_key" text DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "department_name" text;--> statement-breakpoint
ALTER TABLE "conference_room_approvals" ADD CONSTRAINT "conference_room_approvals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conference_room_approvals" ADD CONSTRAINT "conference_room_approvals_conference_room_id_conference_rooms_id_fk" FOREIGN KEY ("conference_room_id") REFERENCES "public"."conference_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conference_room_approvals" ADD CONSTRAINT "conference_room_approvals_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conference_room_approvals" ADD CONSTRAINT "conference_room_approvals_linked_by_agent_id_agents_id_fk" FOREIGN KEY ("linked_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conference_room_comments" ADD CONSTRAINT "conference_room_comments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conference_room_comments" ADD CONSTRAINT "conference_room_comments_conference_room_id_conference_rooms_id_fk" FOREIGN KEY ("conference_room_id") REFERENCES "public"."conference_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conference_room_comments" ADD CONSTRAINT "conference_room_comments_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conference_room_issue_links" ADD CONSTRAINT "conference_room_issue_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conference_room_issue_links" ADD CONSTRAINT "conference_room_issue_links_conference_room_id_conference_rooms_id_fk" FOREIGN KEY ("conference_room_id") REFERENCES "public"."conference_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conference_room_issue_links" ADD CONSTRAINT "conference_room_issue_links_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conference_room_issue_links" ADD CONSTRAINT "conference_room_issue_links_linked_by_agent_id_agents_id_fk" FOREIGN KEY ("linked_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conference_room_participants" ADD CONSTRAINT "conference_room_participants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conference_room_participants" ADD CONSTRAINT "conference_room_participants_conference_room_id_conference_rooms_id_fk" FOREIGN KEY ("conference_room_id") REFERENCES "public"."conference_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conference_room_participants" ADD CONSTRAINT "conference_room_participants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conference_room_participants" ADD CONSTRAINT "conference_room_participants_added_by_agent_id_agents_id_fk" FOREIGN KEY ("added_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conference_rooms" ADD CONSTRAINT "conference_rooms_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conference_rooms" ADD CONSTRAINT "conference_rooms_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conference_room_approvals_room_idx" ON "conference_room_approvals" USING btree ("conference_room_id");--> statement-breakpoint
CREATE INDEX "conference_room_approvals_approval_idx" ON "conference_room_approvals" USING btree ("approval_id");--> statement-breakpoint
CREATE INDEX "conference_room_approvals_company_idx" ON "conference_room_approvals" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conference_room_approvals_room_approval_idx" ON "conference_room_approvals" USING btree ("conference_room_id","approval_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conference_room_approvals_approval_unique_idx" ON "conference_room_approvals" USING btree ("approval_id");--> statement-breakpoint
CREATE INDEX "conference_room_comments_room_idx" ON "conference_room_comments" USING btree ("conference_room_id");--> statement-breakpoint
CREATE INDEX "conference_room_comments_room_created_idx" ON "conference_room_comments" USING btree ("conference_room_id","created_at");--> statement-breakpoint
CREATE INDEX "conference_room_comments_company_idx" ON "conference_room_comments" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "conference_room_issue_links_room_idx" ON "conference_room_issue_links" USING btree ("conference_room_id");--> statement-breakpoint
CREATE INDEX "conference_room_issue_links_issue_idx" ON "conference_room_issue_links" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "conference_room_issue_links_company_idx" ON "conference_room_issue_links" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conference_room_issue_links_room_issue_idx" ON "conference_room_issue_links" USING btree ("conference_room_id","issue_id");--> statement-breakpoint
CREATE INDEX "conference_room_participants_room_idx" ON "conference_room_participants" USING btree ("conference_room_id");--> statement-breakpoint
CREATE INDEX "conference_room_participants_agent_idx" ON "conference_room_participants" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "conference_room_participants_company_idx" ON "conference_room_participants" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conference_room_participants_room_agent_idx" ON "conference_room_participants" USING btree ("conference_room_id","agent_id");--> statement-breakpoint
CREATE INDEX "conference_rooms_company_status_created_idx" ON "conference_rooms" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "conference_rooms_company_updated_idx" ON "conference_rooms" USING btree ("company_id","updated_at");
--> statement-breakpoint
UPDATE "agents"
SET
  "org_level" = CASE
    WHEN "role" IN ('ceo', 'cto', 'cfo', 'cmo', 'coo') THEN 'executive'
    WHEN EXISTS (
      SELECT 1
      FROM "agents" AS "child"
      WHERE "child"."reports_to" = "agents"."id"
    ) THEN 'director'
    ELSE 'staff'
  END,
  "department_key" = CASE
    WHEN "role" = 'ceo' THEN 'executive'
    WHEN "role" IN ('cto', 'engineer', 'qa', 'devops') THEN 'engineering'
    WHEN "role" = 'pm' THEN 'product'
    WHEN "role" = 'designer' THEN 'design'
    WHEN "role" = 'cmo' THEN 'marketing'
    WHEN "role" = 'cfo' THEN 'finance'
    WHEN "role" = 'coo' THEN 'operations'
    WHEN "role" = 'researcher' THEN 'research'
    ELSE 'general'
  END,
  "department_name" = NULL;
--> statement-breakpoint
CREATE TEMP TABLE "conference_room_backfill_map" AS
SELECT
  "a"."id" AS "approval_id",
  gen_random_uuid() AS "conference_room_id"
FROM "approvals" AS "a"
WHERE "a"."type" = 'request_board_approval';
--> statement-breakpoint
INSERT INTO "conference_rooms" (
  "id",
  "company_id",
  "title",
  "summary",
  "agenda",
  "status",
  "created_by_agent_id",
  "created_by_user_id",
  "created_at",
  "updated_at"
)
SELECT
  "map"."conference_room_id",
  "a"."company_id",
  COALESCE(
    NULLIF(btrim(COALESCE("a"."payload"->>'roomTitle', '')), ''),
    NULLIF(btrim(COALESCE("a"."payload"->>'title', '')), ''),
    'Conference Room'
  ) AS "title",
  COALESCE(
    NULLIF(btrim(COALESCE("a"."payload"->>'summary', '')), ''),
    NULLIF(btrim(COALESCE("a"."payload"->>'agenda', '')), ''),
    'Backfilled from legacy board approval'
  ) AS "summary",
  NULLIF(btrim(COALESCE("a"."payload"->>'agenda', '')), '') AS "agenda",
  CASE
    WHEN "a"."status" IN ('pending', 'revision_requested') THEN 'open'
    ELSE 'closed'
  END AS "status",
  "a"."requested_by_agent_id",
  "a"."requested_by_user_id",
  "a"."created_at",
  "a"."updated_at"
FROM "conference_room_backfill_map" AS "map"
INNER JOIN "approvals" AS "a" ON "a"."id" = "map"."approval_id";
--> statement-breakpoint
INSERT INTO "conference_room_approvals" (
  "company_id",
  "conference_room_id",
  "approval_id",
  "linked_by_agent_id",
  "linked_by_user_id",
  "created_at"
)
SELECT
  "a"."company_id",
  "map"."conference_room_id",
  "a"."id",
  "a"."requested_by_agent_id",
  "a"."requested_by_user_id",
  "a"."created_at"
FROM "conference_room_backfill_map" AS "map"
INNER JOIN "approvals" AS "a" ON "a"."id" = "map"."approval_id";
--> statement-breakpoint
INSERT INTO "conference_room_issue_links" (
  "company_id",
  "conference_room_id",
  "issue_id",
  "linked_by_agent_id",
  "linked_by_user_id",
  "created_at"
)
SELECT DISTINCT
  "ia"."company_id",
  "map"."conference_room_id",
  "ia"."issue_id",
  "ia"."linked_by_agent_id",
  "ia"."linked_by_user_id",
  "ia"."created_at"
FROM "conference_room_backfill_map" AS "map"
INNER JOIN "issue_approvals" AS "ia" ON "ia"."approval_id" = "map"."approval_id";
--> statement-breakpoint
INSERT INTO "conference_room_participants" (
  "company_id",
  "conference_room_id",
  "agent_id",
  "added_by_agent_id",
  "added_by_user_id",
  "created_at",
  "updated_at"
)
SELECT DISTINCT
  "a"."company_id",
  "map"."conference_room_id",
  "candidate"."agent_id"::uuid,
  "a"."requested_by_agent_id",
  "a"."requested_by_user_id",
  "a"."created_at",
  "a"."updated_at"
FROM "conference_room_backfill_map" AS "map"
INNER JOIN "approvals" AS "a" ON "a"."id" = "map"."approval_id"
INNER JOIN LATERAL (
  SELECT jsonb_array_elements_text("a"."payload"->'participantAgentIds') AS "agent_id"
  WHERE jsonb_typeof("a"."payload"->'participantAgentIds') = 'array'
) AS "candidate" ON TRUE
INNER JOIN "agents" AS "participant_agent"
  ON "participant_agent"."id" = "candidate"."agent_id"::uuid
 AND "participant_agent"."company_id" = "a"."company_id";
--> statement-breakpoint
INSERT INTO "conference_room_comments" (
  "company_id",
  "conference_room_id",
  "author_agent_id",
  "author_user_id",
  "body",
  "created_at",
  "updated_at"
)
SELECT
  "ac"."company_id",
  "map"."conference_room_id",
  "ac"."author_agent_id",
  "ac"."author_user_id",
  "ac"."body",
  "ac"."created_at",
  "ac"."updated_at"
FROM "conference_room_backfill_map" AS "map"
INNER JOIN "approval_comments" AS "ac" ON "ac"."approval_id" = "map"."approval_id";
--> statement-breakpoint
DROP TABLE "conference_room_backfill_map";

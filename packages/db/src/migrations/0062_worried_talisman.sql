CREATE TABLE "conference_room_question_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"conference_room_id" uuid NOT NULL,
	"question_comment_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"replied_comment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conference_room_comments" ADD COLUMN "parent_comment_id" uuid;--> statement-breakpoint
ALTER TABLE "conference_room_comments" ADD COLUMN "message_type" text DEFAULT 'note' NOT NULL;--> statement-breakpoint
ALTER TABLE "conference_room_question_responses" ADD CONSTRAINT "conference_room_question_responses_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conference_room_question_responses" ADD CONSTRAINT "conference_room_question_responses_conference_room_id_conference_rooms_id_fk" FOREIGN KEY ("conference_room_id") REFERENCES "public"."conference_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conference_room_question_responses" ADD CONSTRAINT "conference_room_question_responses_question_comment_id_conference_room_comments_id_fk" FOREIGN KEY ("question_comment_id") REFERENCES "public"."conference_room_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conference_room_question_responses" ADD CONSTRAINT "conference_room_question_responses_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conference_room_question_responses" ADD CONSTRAINT "conference_room_question_responses_replied_comment_id_conference_room_comments_id_fk" FOREIGN KEY ("replied_comment_id") REFERENCES "public"."conference_room_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conference_room_question_responses_room_idx" ON "conference_room_question_responses" USING btree ("conference_room_id");--> statement-breakpoint
CREATE INDEX "conference_room_question_responses_question_idx" ON "conference_room_question_responses" USING btree ("question_comment_id");--> statement-breakpoint
CREATE INDEX "conference_room_question_responses_agent_idx" ON "conference_room_question_responses" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "conference_room_question_responses_room_status_idx" ON "conference_room_question_responses" USING btree ("conference_room_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "conference_room_question_responses_question_agent_idx" ON "conference_room_question_responses" USING btree ("question_comment_id","agent_id");--> statement-breakpoint
ALTER TABLE "conference_room_comments" ADD CONSTRAINT "conference_room_comments_parent_comment_id_conference_room_comments_id_fk" FOREIGN KEY ("parent_comment_id") REFERENCES "public"."conference_room_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conference_room_comments_room_parent_idx" ON "conference_room_comments" USING btree ("conference_room_id","parent_comment_id");
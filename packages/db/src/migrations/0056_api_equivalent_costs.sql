ALTER TABLE "cost_events" ADD COLUMN "cache_creation_input_tokens" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN "estimated_api_cost_cents" integer;

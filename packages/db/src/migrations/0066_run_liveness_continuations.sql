ALTER TABLE "heartbeat_runs" ADD COLUMN "liveness_state" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN "liveness_reason" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN "continuation_attempt" integer DEFAULT 0 NOT NULL;
ALTER TABLE "heartbeat_runs" ADD COLUMN "last_useful_action_at" timestamp with time zone;
ALTER TABLE "heartbeat_runs" ADD COLUMN "next_action" text;

CREATE INDEX "heartbeat_runs_company_liveness_idx"
  ON "heartbeat_runs" USING btree ("company_id","liveness_state","created_at");

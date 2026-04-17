create table if not exists "issue_decision_questions" (
  "id" uuid primary key default gen_random_uuid(),
  "company_id" uuid not null references "companies"("id"),
  "issue_id" uuid not null references "issues"("id") on delete cascade,
  "target" text not null default 'board',
  "requested_by_agent_id" uuid references "agents"("id") on delete set null,
  "requested_by_user_id" text,
  "status" text not null default 'open',
  "blocking" boolean not null default true,
  "title" text not null,
  "question" text not null,
  "why_blocked" text,
  "recommended_options" jsonb not null default '[]'::jsonb,
  "suggested_default" text,
  "answer" jsonb,
  "answered_by_user_id" text,
  "answered_at" timestamptz,
  "linked_approval_id" uuid references "approvals"("id") on delete set null,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

create index if not exists "issue_decision_questions_company_issue_status_idx"
  on "issue_decision_questions" ("company_id", "issue_id", "status");
create index if not exists "issue_decision_questions_company_status_idx"
  on "issue_decision_questions" ("company_id", "status");
create index if not exists "issue_decision_questions_requested_by_agent_idx"
  on "issue_decision_questions" ("requested_by_agent_id");
create index if not exists "issue_decision_questions_linked_approval_idx"
  on "issue_decision_questions" ("linked_approval_id");

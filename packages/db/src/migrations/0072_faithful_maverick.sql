UPDATE "issues" AS issue
SET "project_id" = project_workspace."project_id"
FROM "project_workspaces" AS project_workspace
WHERE issue."project_id" IS NULL
  AND issue."project_workspace_id" = project_workspace."id"
  AND issue."company_id" = project_workspace."company_id";

UPDATE "issues" AS issue
SET "project_id" = execution_workspace."project_id"
FROM "execution_workspaces" AS execution_workspace
WHERE issue."project_id" IS NULL
  AND issue."execution_workspace_id" = execution_workspace."id"
  AND issue."company_id" = execution_workspace."company_id";

UPDATE "issues" AS issue
SET "project_id" = parent_issue."project_id"
FROM "issues" AS parent_issue
WHERE issue."project_id" IS NULL
  AND issue."parent_id" = parent_issue."id"
  AND issue."company_id" = parent_issue."company_id"
  AND parent_issue."project_id" IS NOT NULL;

WITH "single_execution_scope" AS (
  SELECT
    scope."company_id",
    scope."agent_id",
    min(scope."project_id"::text)::uuid AS "project_id"
  FROM "agent_project_scopes" AS scope
  WHERE scope."scope_mode" = 'execution'
    AND scope."active_from" <= now()
    AND (scope."active_to" IS NULL OR scope."active_to" > now())
  GROUP BY scope."company_id", scope."agent_id"
  HAVING count(DISTINCT scope."project_id") = 1
)
UPDATE "issues" AS issue
SET "project_id" = scoped."project_id"
FROM "single_execution_scope" AS scoped
WHERE issue."project_id" IS NULL
  AND issue."company_id" = scoped."company_id"
  AND issue."assignee_agent_id" = scoped."agent_id";

DO $$
DECLARE
  unresolved_ids text;
BEGIN
  SELECT string_agg(issue."id"::text, ', ' ORDER BY issue."id")
    INTO unresolved_ids
  FROM "issues" AS issue
  WHERE issue."project_id" IS NULL;

  IF unresolved_ids IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot backfill issues.project_id for issues: %', unresolved_ids;
  END IF;
END
$$;

ALTER TABLE "issues" ALTER COLUMN "project_id" SET NOT NULL;

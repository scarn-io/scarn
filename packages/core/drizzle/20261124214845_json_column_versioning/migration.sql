-- Rules published before rule keys were required have none. Give each such
-- rule `rule-<n>` (1-based position), the same key the stored-document reader
-- (`defaultRuleKey`) gives it. `content_hash` is left as published: the next
-- publish of the automation then stores a new version.
UPDATE "app"."automation_versions" AS v
SET "document" = jsonb_set(
  v."document",
  '{rules}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN rule ? 'key' THEN rule
        ELSE rule || jsonb_build_object('key', 'rule-' || position::text)
      END
      ORDER BY position
    )
    FROM jsonb_array_elements(v."document" -> 'rules') WITH ORDINALITY AS r(rule, position)
  )
)
WHERE v."schema_version" = 1
  AND jsonb_typeof(v."document" -> 'rules') = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v."document" -> 'rules') AS r(rule)
    WHERE NOT rule ? 'key'
  );--> statement-breakpoint
ALTER TABLE "app"."pipeline_graph_versions" ADD CONSTRAINT "pipeline_graph_versions_schema_version_check" CHECK ("schema_version" >= 1);--> statement-breakpoint
-- Expand: move a schedule's concurrency out of `concurrency_json` into two
-- integer columns. A key that is missing, not a number, not a whole number or
-- out of integer range takes its `DEFAULT_SCHEDULE_CONCURRENCY` value (max 1,
-- waiting 0). `concurrency_json` stays, nullable and unread, so a rolled-back
-- release still has data; a follow-up migration drops it.
ALTER TABLE "app"."automation_schedules" ADD COLUMN "concurrency_max" integer;--> statement-breakpoint
ALTER TABLE "app"."automation_schedules" ADD COLUMN "concurrency_waiting" integer;--> statement-breakpoint
UPDATE "app"."automation_schedules"
SET
  "concurrency_max" = CASE
    WHEN jsonb_typeof("concurrency_json" -> 'max') <> 'number' THEN 1
    WHEN ("concurrency_json" ->> 'max')::numeric = trunc(("concurrency_json" ->> 'max')::numeric)
      AND ("concurrency_json" ->> 'max')::numeric BETWEEN -2147483648 AND 2147483647
    THEN ("concurrency_json" ->> 'max')::numeric::integer
    ELSE 1
  END,
  "concurrency_waiting" = CASE
    WHEN jsonb_typeof("concurrency_json" -> 'waiting') <> 'number' THEN 0
    WHEN ("concurrency_json" ->> 'waiting')::numeric = trunc(("concurrency_json" ->> 'waiting')::numeric)
      AND ("concurrency_json" ->> 'waiting')::numeric BETWEEN -2147483648 AND 2147483647
    THEN ("concurrency_json" ->> 'waiting')::numeric::integer
    ELSE 0
  END;--> statement-breakpoint
ALTER TABLE "app"."automation_schedules" ALTER COLUMN "concurrency_max" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."automation_schedules" ALTER COLUMN "concurrency_waiting" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."automation_schedules" ALTER COLUMN "concurrency_json" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."project_integrations" ADD COLUMN "schema_version" integer NOT NULL DEFAULT 1;--> statement-breakpoint
ALTER TABLE "app"."project_integrations" ADD CONSTRAINT "project_integrations_schema_version_check" CHECK ("schema_version" >= 1);--> statement-breakpoint
ALTER TABLE "app"."project_integrations" ALTER COLUMN "schema_version" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "app"."step_definitions" ADD COLUMN "schema_version" integer NOT NULL DEFAULT 1;--> statement-breakpoint
ALTER TABLE "app"."step_definitions" ADD CONSTRAINT "step_definitions_schema_version_check" CHECK ("schema_version" >= 1);--> statement-breakpoint
ALTER TABLE "app"."step_definitions" ALTER COLUMN "schema_version" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "app"."secrets" ADD COLUMN "schema_version" integer NOT NULL DEFAULT 1;--> statement-breakpoint
ALTER TABLE "app"."secrets" ADD CONSTRAINT "secrets_schema_version_check" CHECK ("schema_version" >= 1);--> statement-breakpoint
ALTER TABLE "app"."secrets" ALTER COLUMN "schema_version" DROP DEFAULT;--> statement-breakpoint
-- `lanes` and `node_visits` get a `schema_version`. Existing rows are v1;
-- the default only backfills them and is dropped so a writer that forgets the
-- version fails. Both tables are large, so the checks are added `NOT VALID`
-- and validated separately.
ALTER TABLE "app"."lanes" ADD COLUMN "schema_version" integer NOT NULL DEFAULT 1;--> statement-breakpoint
ALTER TABLE "app"."lanes" ADD CONSTRAINT "lanes_schema_version_check" CHECK ("schema_version" >= 1) NOT VALID;--> statement-breakpoint
ALTER TABLE "app"."lanes" VALIDATE CONSTRAINT "lanes_schema_version_check";--> statement-breakpoint
ALTER TABLE "app"."lanes" ALTER COLUMN "schema_version" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "app"."node_visits" ADD COLUMN "schema_version" integer NOT NULL DEFAULT 1;--> statement-breakpoint
ALTER TABLE "app"."node_visits" ADD CONSTRAINT "node_visits_schema_version_check" CHECK ("schema_version" >= 1) NOT VALID;--> statement-breakpoint
ALTER TABLE "app"."node_visits" VALIDATE CONSTRAINT "node_visits_schema_version_check";--> statement-breakpoint
ALTER TABLE "app"."node_visits" ALTER COLUMN "schema_version" DROP DEFAULT;--> statement-breakpoint
-- Expand: move a lane group's `tolerated_failures` (`{ count }` or
-- `{ percent }`) into two columns, exactly one set. A whole-number `count`
-- in integer range is kept; otherwise a numeric `percent` is kept; anything
-- else takes the engine's default, `{ count: 0 }`. `tolerated_failures`
-- stays, nullable and unread, so a rolled-back release still has data; a
-- follow-up migration drops it. A single UPDATE: lane groups are one row per
-- split taken, far fewer than lanes or visits.
ALTER TABLE "app"."lane_groups" ADD COLUMN "tolerated_failures_count" integer;--> statement-breakpoint
ALTER TABLE "app"."lane_groups" ADD COLUMN "tolerated_failures_percent" double precision;--> statement-breakpoint
UPDATE "app"."lane_groups"
SET
  "tolerated_failures_count" = CASE
    WHEN jsonb_typeof("tolerated_failures" -> 'count') = 'number' THEN CASE
      WHEN ("tolerated_failures" ->> 'count')::numeric = trunc(("tolerated_failures" ->> 'count')::numeric)
        AND ("tolerated_failures" ->> 'count')::numeric BETWEEN -2147483648 AND 2147483647
      THEN ("tolerated_failures" ->> 'count')::numeric::integer
      WHEN jsonb_typeof("tolerated_failures" -> 'percent') = 'number' THEN NULL
      ELSE 0
    END
    WHEN jsonb_typeof("tolerated_failures" -> 'percent') = 'number' THEN NULL
    ELSE 0
  END,
  "tolerated_failures_percent" = CASE
    WHEN jsonb_typeof("tolerated_failures" -> 'count') = 'number' THEN CASE
      WHEN ("tolerated_failures" ->> 'count')::numeric = trunc(("tolerated_failures" ->> 'count')::numeric)
        AND ("tolerated_failures" ->> 'count')::numeric BETWEEN -2147483648 AND 2147483647
      THEN NULL
      WHEN jsonb_typeof("tolerated_failures" -> 'percent') = 'number'
      THEN ("tolerated_failures" ->> 'percent')::double precision
      ELSE NULL
    END
    WHEN jsonb_typeof("tolerated_failures" -> 'percent') = 'number'
    THEN ("tolerated_failures" ->> 'percent')::double precision
    ELSE NULL
  END;--> statement-breakpoint
ALTER TABLE "app"."lane_groups" ADD CONSTRAINT "lane_groups_tolerated_failures_check" CHECK (num_nonnulls("tolerated_failures_count", "tolerated_failures_percent") = 1);--> statement-breakpoint
ALTER TABLE "app"."lane_groups" ALTER COLUMN "tolerated_failures" DROP NOT NULL;--> statement-breakpoint
-- `tasks` gets a `schema_version`. Existing rows are v1; the default only
-- backfills them and is dropped so a writer that forgets the version fails.
-- The table is large, so the check is added `NOT VALID` and validated
-- separately.
ALTER TABLE "app"."tasks" ADD COLUMN "schema_version" integer NOT NULL DEFAULT 1;--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD CONSTRAINT "tasks_schema_version_check" CHECK ("schema_version" >= 1) NOT VALID;--> statement-breakpoint
ALTER TABLE "app"."tasks" VALIDATE CONSTRAINT "tasks_schema_version_check";--> statement-breakpoint
ALTER TABLE "app"."tasks" ALTER COLUMN "schema_version" DROP DEFAULT;

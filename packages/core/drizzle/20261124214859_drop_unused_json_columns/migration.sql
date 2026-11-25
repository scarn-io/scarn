-- Before this ships: run `audit-stored-json.ts` (from the release before this
-- one) against prod and confirm `work_item_sources` has no rows. Nothing in
-- the code reads or writes it, and its `credentials` column holds secrets,
-- so rows are not kept or copied anywhere.
DROP TABLE "app"."work_item_sources";--> statement-breakpoint
-- Contract: `tolerated_failures` and `concurrency_json` were superseded by
-- plain columns (`tolerated_failures_count` / `_percent`, backfilled in
-- 20261124214845_json_column_versioning; `concurrency_max` /
-- `_waiting`, backfilled in the same migration)
-- and have been written but not read since. A rollback past this migration
-- needs those columns back.
ALTER TABLE "app"."lane_groups" DROP COLUMN "tolerated_failures";--> statement-breakpoint
ALTER TABLE "app"."automation_schedules" DROP COLUMN "concurrency_json";

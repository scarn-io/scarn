ALTER TABLE "app"."step_definitions" ADD COLUMN "grants_json" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD COLUMN "grants_json" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."step_definitions" DROP COLUMN "work_item_permissions_json";--> statement-breakpoint
ALTER TABLE "app"."task_runs" DROP COLUMN "yield_kind";--> statement-breakpoint
ALTER TABLE "app"."tasks" DROP COLUMN "work_item_permissions";--> statement-breakpoint
DROP TYPE "public"."task_run_yield_kind";
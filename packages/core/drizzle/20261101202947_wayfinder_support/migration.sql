CREATE TYPE "public"."task_run_yield_kind" AS ENUM('hand_over', 'wait_for_work');--> statement-breakpoint
CREATE TYPE "public"."work_item_close_reason" AS ENUM('completed', 'out_of_scope', 'superseded');--> statement-breakpoint
ALTER TYPE "public"."task_lifecycle_status" ADD VALUE 'waiting_for_work' BEFORE 'queued';--> statement-breakpoint
ALTER TABLE "app"."step_definition_templates" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "app"."step_definition_templates" CASCADE;--> statement-breakpoint
ALTER TABLE "app"."node_visits" DROP CONSTRAINT "node_visits_conversation_id_conversations_id_fk";
--> statement-breakpoint
DROP INDEX "app"."node_visits_conversation_id_unique";--> statement-breakpoint
ALTER TABLE "app"."projects" ADD COLUMN "default_step_definition_key" text;--> statement-breakpoint
ALTER TABLE "app"."step_definitions" ADD COLUMN "work_item_permissions_json" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."step_definitions" ADD COLUMN "max_turns" integer;--> statement-breakpoint
ALTER TABLE "app"."task_runs" ADD COLUMN "yield_kind" "task_run_yield_kind";--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD COLUMN "work_item_permissions" jsonb DEFAULT '["self"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."user_notifications" ADD COLUMN "recipient_user_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."work_item_comments" ADD COLUMN "authored_by_task_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."work_items" ADD COLUMN "description_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."work_items" ADD COLUMN "assignee_user_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."work_items" ADD COLUMN "close_reason" "work_item_close_reason";--> statement-breakpoint
ALTER TABLE "app"."work_items" ADD COLUMN "resolution" text;--> statement-breakpoint
ALTER TABLE "app"."work_items" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."work_items" ADD COLUMN "closed_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."work_items" ADD COLUMN "closed_by_task_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD CONSTRAINT "tasks_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "app"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."work_item_comments" ADD CONSTRAINT "work_item_comments_authored_by_task_id_tasks_id_fk" FOREIGN KEY ("authored_by_task_id") REFERENCES "app"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."work_items" ADD CONSTRAINT "work_items_closed_by_task_id_tasks_id_fk" FOREIGN KEY ("closed_by_task_id") REFERENCES "app"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_conversation_id_unique" ON "app"."tasks" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "user_notifications_project_recipient_idx" ON "app"."user_notifications" USING btree ("project_id","recipient_user_id");--> statement-breakpoint
UPDATE "app"."tasks" SET "conversation_id" = nv."conversation_id" FROM "app"."node_visits" nv WHERE nv."task_id" = "app"."tasks"."id" AND nv."conversation_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."node_visits" DROP COLUMN "conversation_id";--> statement-breakpoint
UPDATE "app"."work_items" SET "close_reason" = 'completed', "closed_at" = coalesce("source_updated_at", "updated_at") WHERE "state" = 'closed';--> statement-breakpoint
ALTER TABLE "app"."projects" ADD CONSTRAINT "projects_default_assignment_single_target" CHECK ("app"."projects"."default_pipeline_id" is null or "app"."projects"."default_step_definition_key" is null);--> statement-breakpoint
ALTER TABLE "app"."work_items" ADD CONSTRAINT "work_items_closure_matches_state_check" CHECK (("app"."work_items"."state" = 'closed' and "app"."work_items"."close_reason" is not null and "app"."work_items"."closed_at" is not null) or ("app"."work_items"."state" = 'open' and "app"."work_items"."close_reason" is null and "app"."work_items"."resolution" is null and "app"."work_items"."closed_at" is null and "app"."work_items"."closed_by_user_id" is null and "app"."work_items"."closed_by_task_id" is null));
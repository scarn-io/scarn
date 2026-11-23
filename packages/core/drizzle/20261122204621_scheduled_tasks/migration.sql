ALTER TABLE "app"."tasks" DROP CONSTRAINT "tasks_work_item_or_conversation_check";--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD COLUMN "started_by_schedule_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD COLUMN "scheduled_for" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_started_by_schedule_id_scheduled_for_unique" ON "app"."tasks" ("started_by_schedule_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "tasks_started_by_schedule_id_status_scheduled_for_idx" ON "app"."tasks" ("started_by_schedule_id","status","scheduled_for" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD CONSTRAINT "tasks_started_by_schedule_id_automation_schedules_id_fkey" FOREIGN KEY ("started_by_schedule_id") REFERENCES "app"."automation_schedules"("id");--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD CONSTRAINT "tasks_owner_check" CHECK ("work_item_id" IS NOT NULL OR "conversation_id" IS NOT NULL OR "started_by_schedule_id" IS NOT NULL);
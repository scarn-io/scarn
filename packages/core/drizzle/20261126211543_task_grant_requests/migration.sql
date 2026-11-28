CREATE TYPE "task_grant_request_status" AS ENUM('pending', 'decided', 'unanswered', 'withdrawn');--> statement-breakpoint
CREATE TABLE "app"."task_grant_requests" (
	"id" uuid PRIMARY KEY,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"task_run_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"requested_json" jsonb NOT NULL,
	"status" "task_grant_request_status" NOT NULL,
	"approved_json" jsonb,
	"note" text,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"schema_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_grant_requests_schema_version_check" CHECK ("schema_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "app"."conversation_messages" ADD COLUMN "grant_request_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."step_definitions" ADD COLUMN "grant_requests" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD COLUMN "grant_requests" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD COLUMN "held_work_item_changes_json" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE INDEX "conversation_messages_grant_request_id_idx" ON "app"."conversation_messages" ("grant_request_id");--> statement-breakpoint
CREATE INDEX "task_grant_requests_project_id_idx" ON "app"."task_grant_requests" ("project_id");--> statement-breakpoint
CREATE INDEX "task_grant_requests_task_id_idx" ON "app"."task_grant_requests" ("task_id");--> statement-breakpoint
CREATE INDEX "task_grant_requests_task_run_id_idx" ON "app"."task_grant_requests" ("task_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_grant_requests_task_id_pending_unique" ON "app"."task_grant_requests" ("task_id") WHERE "status" = 'pending';--> statement-breakpoint
ALTER TABLE "app"."conversation_messages" ADD CONSTRAINT "conversation_messages_RHCLuZOYYrar_fkey" FOREIGN KEY ("grant_request_id") REFERENCES "app"."task_grant_requests"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "app"."task_grant_requests" ADD CONSTRAINT "task_grant_requests_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."task_grant_requests" ADD CONSTRAINT "task_grant_requests_task_id_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "app"."tasks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."task_grant_requests" ADD CONSTRAINT "task_grant_requests_task_run_id_task_runs_id_fkey" FOREIGN KEY ("task_run_id") REFERENCES "app"."task_runs"("id") ON DELETE CASCADE;
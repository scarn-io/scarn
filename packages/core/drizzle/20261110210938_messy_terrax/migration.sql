CREATE TABLE "app"."storage_sweeps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"task_run_id" uuid NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."task_runs" ALTER COLUMN "work_item_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."tasks" ALTER COLUMN "work_item_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."task_runs" ADD COLUMN "base_commit" text;--> statement-breakpoint
ALTER TABLE "app"."task_runs" ADD COLUMN "session_size_bytes" bigint;--> statement-breakpoint
CREATE INDEX "storage_sweeps_not_before_idx" ON "app"."storage_sweeps" USING btree ("not_before");--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD CONSTRAINT "tasks_work_item_or_conversation_check" CHECK ("app"."tasks"."work_item_id" IS NOT NULL OR "app"."tasks"."conversation_id" IS NOT NULL);
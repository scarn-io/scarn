CREATE TABLE "app"."automation_schedules" (
	"id" uuid PRIMARY KEY,
	"automation_id" uuid NOT NULL,
	"key" text NOT NULL,
	"cron" text NOT NULL,
	"timezone" text NOT NULL,
	"concurrency_json" jsonb NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_fired_at" timestamp with time zone,
	"last_skipped_at" timestamp with time zone,
	"skipped_count_since_fire" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "automation_schedules_automation_key_live_unique" ON "app"."automation_schedules" ("automation_id","key") WHERE "removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "automation_schedules_next_run_at_live_idx" ON "app"."automation_schedules" ("next_run_at") WHERE "removed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "app"."automation_schedules" ADD CONSTRAINT "automation_schedules_automation_id_automations_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "app"."automations"("id") ON DELETE CASCADE;
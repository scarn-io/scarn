CREATE TYPE "artifact_share_created_via" AS ENUM('person', 'step');--> statement-breakpoint
CREATE TYPE "task_artifact_bundle_status" AS ENUM('pending', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "app"."artifact_shares" (
	"id" uuid PRIMARY KEY,
	"project_id" uuid NOT NULL,
	"bundle_id" uuid NOT NULL,
	"created_via" "artifact_share_created_via" NOT NULL,
	"created_by_user_id" uuid,
	"created_by_task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid
);
--> statement-breakpoint
CREATE TABLE "app"."task_artifact_bundles" (
	"id" uuid PRIMARY KEY,
	"project_id" uuid NOT NULL,
	"task_run_id" uuid NOT NULL,
	"name" text NOT NULL,
	"field_path" text,
	"root_path" text NOT NULL,
	"entry_path" text NOT NULL,
	"status" "task_artifact_bundle_status" DEFAULT 'pending'::"task_artifact_bundle_status" NOT NULL,
	"file_count" integer,
	"size_bytes" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "app"."task_artifacts" ADD COLUMN "bundle_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_shares_bundle_active_unique" ON "app"."artifact_shares" ("bundle_id") WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "artifact_shares_project_id_idx" ON "app"."artifact_shares" ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_artifact_bundles_task_run_name_unique" ON "app"."task_artifact_bundles" ("task_run_id","name");--> statement-breakpoint
CREATE INDEX "task_artifact_bundles_project_id_idx" ON "app"."task_artifact_bundles" ("project_id");--> statement-breakpoint
CREATE INDEX "task_artifact_bundles_status_created_at_idx" ON "app"."task_artifact_bundles" ("status","created_at");--> statement-breakpoint
CREATE INDEX "task_artifacts_bundle_id_idx" ON "app"."task_artifacts" ("bundle_id");--> statement-breakpoint
ALTER TABLE "app"."artifact_shares" ADD CONSTRAINT "artifact_shares_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."artifact_shares" ADD CONSTRAINT "artifact_shares_bundle_id_task_artifact_bundles_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "app"."task_artifact_bundles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."artifact_shares" ADD CONSTRAINT "artifact_shares_created_by_task_id_tasks_id_fkey" FOREIGN KEY ("created_by_task_id") REFERENCES "app"."tasks"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "app"."task_artifact_bundles" ADD CONSTRAINT "task_artifact_bundles_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."task_artifact_bundles" ADD CONSTRAINT "task_artifact_bundles_task_run_id_task_runs_id_fkey" FOREIGN KEY ("task_run_id") REFERENCES "app"."task_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."task_artifacts" ADD CONSTRAINT "task_artifacts_bundle_id_task_artifact_bundles_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "app"."task_artifact_bundles"("id") ON DELETE SET NULL;
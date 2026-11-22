CREATE TYPE "public"."automation_scope" AS ENUM('workItem', 'project');--> statement-breakpoint
CREATE TYPE "public"."work_item_activity_kind" AS ENUM('automation');--> statement-breakpoint
ALTER TYPE "public"."task_lifecycle_status" ADD VALUE 'waiting_for_concurrency_slot' BEFORE 'waiting_for_work';--> statement-breakpoint
CREATE TABLE "app"."automation_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"automation_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"document" jsonb NOT NULL,
	"schema_version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."automations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"key" text NOT NULL,
	"title" text,
	"scope" "automation_scope" NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."work_item_activity" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"kind" "work_item_activity_kind" NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."work_item_automations" (
	"work_item_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"attached_by_user_id" uuid NOT NULL,
	"attached_at" timestamp with time zone NOT NULL,
	CONSTRAINT "work_item_automations_work_item_id_automation_id_pk" PRIMARY KEY("work_item_id","automation_id")
);
--> statement-breakpoint
ALTER TABLE "app"."projects" DROP CONSTRAINT "projects_default_assignment_single_target";--> statement-breakpoint
ALTER TABLE "app"."projects" DROP CONSTRAINT "projects_default_pipeline_id_pipeline_graphs_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."step_definitions" ADD COLUMN "concurrency_json" jsonb;--> statement-breakpoint
ALTER TABLE "app"."work_items" ADD COLUMN "labels" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."automation_versions" ADD CONSTRAINT "automation_versions_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "app"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."automations" ADD CONSTRAINT "automations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."work_item_activity" ADD CONSTRAINT "work_item_activity_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."work_item_activity" ADD CONSTRAINT "work_item_activity_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "app"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."work_item_automations" ADD CONSTRAINT "work_item_automations_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "app"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."work_item_automations" ADD CONSTRAINT "work_item_automations_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "app"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_versions_automation_version_unique" ON "app"."automation_versions" USING btree ("automation_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "automations_project_key_unique" ON "app"."automations" USING btree ("project_id","key");--> statement-breakpoint
CREATE INDEX "work_item_activity_work_item_idx" ON "app"."work_item_activity" USING btree ("work_item_id","created_at");--> statement-breakpoint
CREATE INDEX "work_item_automations_automation_id_idx" ON "app"."work_item_automations" USING btree ("automation_id");--> statement-breakpoint
CREATE INDEX "work_items_labels_idx" ON "app"."work_items" USING gin ("labels");--> statement-breakpoint
ALTER TABLE "app"."projects" DROP COLUMN "default_pipeline_assignment_json";--> statement-breakpoint
ALTER TABLE "app"."projects" DROP COLUMN "default_pipeline_id";--> statement-breakpoint
ALTER TABLE "app"."projects" DROP COLUMN "default_step_definition_key";--> statement-breakpoint
ALTER TABLE "app"."projects" DROP COLUMN "default_pipeline_event_type";--> statement-breakpoint
ALTER TABLE "app"."projects" DROP COLUMN "default_pipeline_allowed_event_types";--> statement-breakpoint
ALTER TABLE "app"."projects" DROP COLUMN "default_pipeline_rules_json";--> statement-breakpoint
ALTER TABLE "app"."projects" DROP COLUMN "default_pipeline_event_params_json";--> statement-breakpoint
DROP TYPE "public"."default_pipeline_assignment_event_type";
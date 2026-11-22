ALTER TYPE "public"."user_notification_kind" ADD VALUE 'integration_auto_sync_paused';--> statement-breakpoint
ALTER TABLE "app"."project_integrations" ADD COLUMN "sync_secret_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."project_integrations" ADD COLUMN "sync_locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."project_integrations" ADD COLUMN "auto_sync_paused_reason" text;--> statement-breakpoint
ALTER TABLE "app"."project_integrations" ADD COLUMN "auto_sync_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."project_integrations" ADD COLUMN "auto_sync_paused_detail" text;--> statement-breakpoint
ALTER TABLE "app"."project_integrations" ADD CONSTRAINT "project_integrations_sync_secret_id_secrets_id_fk" FOREIGN KEY ("sync_secret_id") REFERENCES "app"."secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_integrations_sync_secret_id_idx" ON "app"."project_integrations" USING btree ("sync_secret_id");--> statement-breakpoint
ALTER TABLE "app"."project_integrations" ADD CONSTRAINT "project_integrations_sync_secret_kind_check" CHECK ("app"."project_integrations"."sync_secret_id" IS NULL OR "app"."project_integrations"."kind" IN ('jira', 'github_token'));--> statement-breakpoint
ALTER TABLE "app"."project_integrations" ADD CONSTRAINT "project_integrations_auto_sync_paused_reason_check" CHECK ("app"."project_integrations"."auto_sync_paused_reason" IS NULL OR "app"."project_integrations"."auto_sync_paused_reason" IN ('key_removed', 'key_rejected', 'key_expired', 'owner_left_project', 'access_lost'));
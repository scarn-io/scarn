-- Lent-key auto-sync is gone (ADR 0018). Its notifications and rules go with
-- it before the enum value they use is dropped; their deliveries cascade.
DELETE FROM "app"."user_notifications" WHERE "kind" = 'integration_auto_sync_paused';--> statement-breakpoint
DELETE FROM "app"."notification_rules" WHERE "kind" = 'integration_auto_sync_paused';--> statement-breakpoint
ALTER TABLE "app"."project_integrations" DROP CONSTRAINT "project_integrations_sync_secret_id_secrets_id_fk";--> statement-breakpoint
ALTER TABLE "app"."project_integrations" DROP CONSTRAINT "project_integrations_sync_secret_kind_check";--> statement-breakpoint
ALTER TABLE "app"."project_integrations" DROP CONSTRAINT "project_integrations_auto_sync_paused_reason_check";--> statement-breakpoint
DROP INDEX "app"."project_integrations_sync_secret_id_idx";--> statement-breakpoint
ALTER TABLE "app"."notification_rules" ALTER COLUMN "kind" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "app"."user_notifications" ALTER COLUMN "kind" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."user_notification_kind";--> statement-breakpoint
CREATE TYPE "public"."user_notification_kind" AS ENUM('feedback_request', 'status_update', 'blocked', 'result_ready', 'warning');--> statement-breakpoint
ALTER TABLE "app"."notification_rules" ALTER COLUMN "kind" SET DATA TYPE "public"."user_notification_kind" USING "kind"::"public"."user_notification_kind";--> statement-breakpoint
ALTER TABLE "app"."user_notifications" ALTER COLUMN "kind" SET DATA TYPE "public"."user_notification_kind" USING "kind"::"public"."user_notification_kind";--> statement-breakpoint
ALTER TABLE "app"."project_integrations" DROP COLUMN "sync_secret_id";--> statement-breakpoint
ALTER TABLE "app"."project_integrations" DROP COLUMN "sync_locked_until";--> statement-breakpoint
ALTER TABLE "app"."project_integrations" DROP COLUMN "auto_sync_paused_reason";--> statement-breakpoint
ALTER TABLE "app"."project_integrations" DROP COLUMN "auto_sync_paused_at";--> statement-breakpoint
ALTER TABLE "app"."project_integrations" DROP COLUMN "auto_sync_paused_detail";

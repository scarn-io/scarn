ALTER TYPE "step_definition_kind" ADD VALUE 'mcp_tool';--> statement-breakpoint
ALTER TYPE "task_kind" ADD VALUE 'mcp_tool';--> statement-breakpoint
ALTER TABLE "app"."managed_mcp_connections" ADD COLUMN "supplied_client_id" text;--> statement-breakpoint
ALTER TABLE "app"."managed_mcp_connections" ADD COLUMN "supplied_redirect_uri" text;--> statement-breakpoint
ALTER TABLE "app"."managed_mcp_connections" ADD COLUMN "discovery" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."managed_mcp_connections" ADD COLUMN "scopes" text[];--> statement-breakpoint
ALTER TABLE "app"."managed_oauth_attempts" ADD COLUMN "completion" text DEFAULT 'server_callback' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."managed_oauth_attempts" ADD COLUMN "completion_secret_digest" text;--> statement-breakpoint
ALTER TABLE "app"."step_definitions" ADD COLUMN "tool_call_json" jsonb;--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD COLUMN "tool_call_json" jsonb;--> statement-breakpoint
ALTER TABLE "app"."managed_oauth_attempts" ALTER COLUMN "browser_session_digest" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."managed_mcp_connections" ADD CONSTRAINT "managed_mcp_connections_supplied_client_check" CHECK (("client_registration" = 'supplied' and "supplied_client_id" is not null and "supplied_redirect_uri" is not null)
        or ("client_registration" <> 'supplied' and "supplied_client_id" is null and "supplied_redirect_uri" is null));--> statement-breakpoint
ALTER TABLE "app"."managed_oauth_attempts" ADD CONSTRAINT "managed_oauth_attempts_completion_check" CHECK (("completion" = 'server_callback' and "browser_session_digest" is not null and "completion_secret_digest" is null)
        or ("completion" = 'loopback' and "browser_session_digest" is null and "completion_secret_digest" is not null));--> statement-breakpoint
ALTER TABLE "app"."tasks" DROP CONSTRAINT "tasks_kind_instructions_check", ADD CONSTRAINT "tasks_kind_instructions_check" CHECK (("kind" = 'agent' AND "prompt" IS NOT NULL AND "entrypoint_json" IS NULL AND "tool_call_json" IS NULL) OR ("kind" = 'code' AND "entrypoint_json" IS NOT NULL AND "prompt" IS NULL AND "tool_call_json" IS NULL) OR ("kind"::text = 'mcp_tool' AND "tool_call_json" IS NOT NULL AND "prompt" IS NULL AND "entrypoint_json" IS NULL));
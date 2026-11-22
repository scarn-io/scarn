CREATE TYPE "managed_connection_event_type" AS ENUM('connect_started', 'reconnect_started', 'attempt_failed', 'candidate_attached', 'candidate_confirmed', 'candidate_cancelled', 'candidate_expired', 'reconnect_required', 'disconnected', 'revocation_attempted', 'refresh_succeeded', 'refresh_failed', 'refresh_claim_recovered', 'launch_registered', 'authority_lost');--> statement-breakpoint
CREATE TYPE "managed_connection_state" AS ENUM('disconnected', 'connecting', 'awaiting_confirmation', 'ready', 'ready_with_pending_reconnect', 'reconnect_required');--> statement-breakpoint
CREATE TYPE "managed_launch_connection_state" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "managed_oauth_attempt_kind" AS ENUM('connect', 'reconnect');--> statement-breakpoint
CREATE TYPE "managed_oauth_attempt_status" AS ENUM('pending', 'exchanging', 'succeeded', 'failed', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "managed_revocation_outcome" AS ENUM('accepted', 'failed', 'unconfirmed');--> statement-breakpoint
CREATE TABLE "app"."managed_connection_events" (
	"id" uuid PRIMARY KEY,
	"project_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"task_run_id" uuid,
	"type" "managed_connection_event_type" NOT NULL,
	"generation" integer NOT NULL,
	"reason_code" text,
	"revocation_outcome" "managed_revocation_outcome",
	"same_identity_as_active" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."managed_mcp_connections" (
	"id" uuid PRIMARY KEY,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"label" text NOT NULL,
	"resource" text NOT NULL,
	"issuer_origin" text NOT NULL,
	"client_registration" text NOT NULL,
	"preset" text,
	"state" "managed_connection_state" NOT NULL,
	"reason_code" text,
	"generation" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"active_grant_id" uuid,
	"candidate_grant_id" uuid,
	"connected_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_mcp_connections_state_shape_check" CHECK (("state" = 'disconnected' and "active_grant_id" is null and "candidate_grant_id" is null and "connected_by_user_id" is null)
        or ("state" = 'connecting' and "active_grant_id" is null and "candidate_grant_id" is null and "connected_by_user_id" is null and "reason_code" is null)
        or ("state" = 'awaiting_confirmation' and "active_grant_id" is null and "candidate_grant_id" is not null and "connected_by_user_id" is null and "reason_code" is null)
        or ("state" = 'ready' and "active_grant_id" is not null and "candidate_grant_id" is null and "connected_by_user_id" is not null and "reason_code" is null)
        or ("state" = 'ready_with_pending_reconnect' and "active_grant_id" is not null and "candidate_grant_id" is not null and "connected_by_user_id" is not null and "reason_code" is null)
        or ("state" = 'reconnect_required' and "active_grant_id" is not null and "connected_by_user_id" is not null and "reason_code" is not null)),
	CONSTRAINT "managed_mcp_connections_counters_check" CHECK ("generation" >= 0 and "version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."managed_mcp_launch_connections" (
	"id" uuid PRIMARY KEY,
	"project_id" uuid NOT NULL,
	"task_run_id" uuid NOT NULL,
	"claim_token_digest" bytea NOT NULL,
	"entry_key" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"grant_id" uuid NOT NULL,
	"capability_digest" bytea NOT NULL,
	"mcp_session_id_digest" bytea,
	"state" "managed_launch_connection_state" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "managed_mcp_launch_connections_closed_shape_check" CHECK (("state" = 'closed') = ("closed_at" is not null)),
	CONSTRAINT "managed_mcp_launch_connections_generation_check" CHECK ("generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."managed_mcp_operations" (
	"id" uuid PRIMARY KEY,
	"launch_connection_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	CONSTRAINT "managed_mcp_operations_deadline_check" CHECK ("deadline_at" > "started_at")
);
--> statement-breakpoint
CREATE TABLE "app"."managed_oauth_attempts" (
	"id" uuid PRIMARY KEY,
	"connection_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "managed_oauth_attempt_kind" NOT NULL,
	"expected_generation" integer NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"browser_session_digest" text NOT NULL,
	"state_digest" text NOT NULL,
	"pkce_verifier_ciphertext" bytea,
	"pkce_verifier_iv" bytea,
	"pkce_verifier_auth_tag" bytea,
	"pkce_verifier_key_version" integer,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"requested_scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "managed_oauth_attempt_status" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"candidate_grant_id" uuid,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_oauth_attempts_verifier_shape_check" CHECK (("status" in ('pending', 'exchanging') and num_nonnulls("pkce_verifier_ciphertext", "pkce_verifier_iv", "pkce_verifier_auth_tag", "pkce_verifier_key_version") = 4)
        or ("status" not in ('pending', 'exchanging') and num_nonnulls("pkce_verifier_ciphertext", "pkce_verifier_iv", "pkce_verifier_auth_tag", "pkce_verifier_key_version") = 0)),
	CONSTRAINT "managed_oauth_attempts_failure_code_check" CHECK (("status" = 'failed') = ("failure_code" is not null))
);
--> statement-breakpoint
CREATE TABLE "app"."managed_oauth_clients" (
	"id" uuid PRIMARY KEY,
	"issuer" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"client_id" text NOT NULL,
	"registered_at" timestamp with time zone NOT NULL,
	"stale_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app"."managed_oauth_grants" (
	"id" uuid PRIMARY KEY,
	"connection_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"issuer" text NOT NULL,
	"resource" text NOT NULL,
	"credential_version" integer DEFAULT 1 NOT NULL,
	"credentials_ciphertext" bytea,
	"credentials_iv" bytea,
	"credentials_auth_tag" bytea,
	"credentials_key_version" integer,
	"identity_ciphertext" bytea NOT NULL,
	"identity_iv" bytea NOT NULL,
	"identity_auth_tag" bytea NOT NULL,
	"identity_key_version" integer NOT NULL,
	"granted_scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"authorized_at" timestamp with time zone NOT NULL,
	"reconnect_by" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone,
	"refresh_claim_id" uuid,
	"refresh_claimed_at" timestamp with time zone,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_oauth_grants_refresh_claim_shape_check" CHECK (num_nonnulls("refresh_claim_id", "refresh_claimed_at") in (0, 2)
        and ("retired_at" is null or "refresh_claim_id" is null)),
	CONSTRAINT "managed_oauth_grants_credentials_shape_check" CHECK (("retired_at" is null and num_nonnulls("credentials_ciphertext", "credentials_iv", "credentials_auth_tag", "credentials_key_version") = 4)
        or ("retired_at" is not null and num_nonnulls("credentials_ciphertext", "credentials_iv", "credentials_auth_tag", "credentials_key_version") = 0))
);
--> statement-breakpoint
CREATE INDEX "managed_connection_events_connection_id_idx" ON "app"."managed_connection_events" ("connection_id");--> statement-breakpoint
CREATE INDEX "managed_connection_events_created_at_idx" ON "app"."managed_connection_events" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_mcp_connections_project_name_unique" ON "app"."managed_mcp_connections" ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_mcp_connections_project_resource_unique" ON "app"."managed_mcp_connections" ("project_id","resource");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_mcp_launch_connections_capability_digest_unique" ON "app"."managed_mcp_launch_connections" ("capability_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_mcp_launch_connections_run_claim_entry_unique" ON "app"."managed_mcp_launch_connections" ("task_run_id","claim_token_digest","entry_key");--> statement-breakpoint
CREATE INDEX "managed_mcp_launch_connections_task_run_state_idx" ON "app"."managed_mcp_launch_connections" ("task_run_id","state");--> statement-breakpoint
CREATE INDEX "managed_mcp_launch_connections_connection_id_idx" ON "app"."managed_mcp_launch_connections" ("connection_id");--> statement-breakpoint
CREATE INDEX "managed_mcp_operations_launch_connection_id_idx" ON "app"."managed_mcp_operations" ("launch_connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_oauth_attempts_state_digest_unique" ON "app"."managed_oauth_attempts" ("state_digest");--> statement-breakpoint
CREATE INDEX "managed_oauth_attempts_connection_id_idx" ON "app"."managed_oauth_attempts" ("connection_id");--> statement-breakpoint
CREATE INDEX "managed_oauth_attempts_expires_at_idx" ON "app"."managed_oauth_attempts" ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_oauth_clients_issuer_redirect_uri_live_unique" ON "app"."managed_oauth_clients" ("issuer","redirect_uri") WHERE "stale_at" IS NULL;--> statement-breakpoint
CREATE INDEX "managed_oauth_grants_connection_id_idx" ON "app"."managed_oauth_grants" ("connection_id");--> statement-breakpoint
CREATE INDEX "managed_oauth_grants_retired_at_idx" ON "app"."managed_oauth_grants" ("retired_at");--> statement-breakpoint
ALTER TABLE "app"."managed_connection_events" ADD CONSTRAINT "managed_connection_events_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."managed_connection_events" ADD CONSTRAINT "managed_connection_events_TeZnLvs169Uu_fkey" FOREIGN KEY ("connection_id") REFERENCES "app"."managed_mcp_connections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."managed_mcp_connections" ADD CONSTRAINT "managed_mcp_connections_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."managed_mcp_connections" ADD CONSTRAINT "managed_mcp_connections_TUuDwmG6oZXm_fkey" FOREIGN KEY ("active_grant_id") REFERENCES "app"."managed_oauth_grants"("id");--> statement-breakpoint
ALTER TABLE "app"."managed_mcp_connections" ADD CONSTRAINT "managed_mcp_connections_14Y1K6OwfIdr_fkey" FOREIGN KEY ("candidate_grant_id") REFERENCES "app"."managed_oauth_grants"("id");--> statement-breakpoint
ALTER TABLE "app"."managed_mcp_launch_connections" ADD CONSTRAINT "managed_mcp_launch_connections_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."managed_mcp_launch_connections" ADD CONSTRAINT "managed_mcp_launch_connections_task_run_id_task_runs_id_fkey" FOREIGN KEY ("task_run_id") REFERENCES "app"."task_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."managed_mcp_launch_connections" ADD CONSTRAINT "managed_mcp_launch_connections_yNLy1zUhkTDk_fkey" FOREIGN KEY ("connection_id") REFERENCES "app"."managed_mcp_connections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."managed_mcp_operations" ADD CONSTRAINT "managed_mcp_operations_KHwaDenyeQIN_fkey" FOREIGN KEY ("launch_connection_id") REFERENCES "app"."managed_mcp_launch_connections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."managed_oauth_attempts" ADD CONSTRAINT "managed_oauth_attempts_NOsqzlI89DCs_fkey" FOREIGN KEY ("connection_id") REFERENCES "app"."managed_mcp_connections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."managed_oauth_attempts" ADD CONSTRAINT "managed_oauth_attempts_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."managed_oauth_attempts" ADD CONSTRAINT "managed_oauth_attempts_DsloKfT1zaVX_fkey" FOREIGN KEY ("candidate_grant_id") REFERENCES "app"."managed_oauth_grants"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "app"."managed_oauth_grants" ADD CONSTRAINT "managed_oauth_grants_B5042XJiRidT_fkey" FOREIGN KEY ("connection_id") REFERENCES "app"."managed_mcp_connections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."managed_oauth_grants" ADD CONSTRAINT "managed_oauth_grants_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE CASCADE;
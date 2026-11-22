CREATE SCHEMA "app";
--> statement-breakpoint
CREATE TYPE "public"."agent_session_status" AS ENUM('running', 'ended', 'failed');--> statement-breakpoint
CREATE TYPE "public"."conversation_message_author_kind" AS ENUM('agent', 'person', 'system');--> statement-breakpoint
CREATE TYPE "public"."conversation_status" AS ENUM('agent_turn', 'waiting_for_person', 'reply_pending', 'closed');--> statement-breakpoint
CREATE TYPE "public"."default_pipeline_assignment_event_type" AS ENUM('assign', 'skip');--> statement-breakpoint
CREATE TYPE "public"."github_relationship_ref_kind" AS ENUM('parent', 'blocked_by');--> statement-breakpoint
CREATE TYPE "public"."lane_group_kind" AS ENUM('each', 'all');--> statement-breakpoint
CREATE TYPE "public"."lane_group_status" AS ENUM('open', 'merged', 'failed');--> statement-breakpoint
CREATE TYPE "public"."lane_origin" AS ENUM('split', 'merge');--> statement-breakpoint
CREATE TYPE "public"."lane_status" AS ENUM('pending', 'active', 'arrived', 'ended', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."node_visit_kind" AS ENUM('step', 'wait', 'succeed', 'fail');--> statement-breakpoint
CREATE TYPE "public"."node_visit_question_status" AS ENUM('open', 'answered', 'not_needed');--> statement-breakpoint
CREATE TYPE "public"."node_visit_status" AS ENUM('active', 'waiting', 'succeeded', 'failed', 'cancelled', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."notification_audience" AS ENUM('assignee', 'reporter', 'project_admins', 'specific_users');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('in_app', 'work_item_platform_comment', 'email', 'slack');--> statement-breakpoint
CREATE TYPE "public"."notification_delivery_status" AS ENUM('pending', 'sent', 'failed', 'suppressed');--> statement-breakpoint
CREATE TYPE "public"."notification_priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."notification_source" AS ENUM('agent', 'system', 'user');--> statement-breakpoint
CREATE TYPE "public"."pipeline_run_status" AS ENUM('active', 'waiting', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."project_integration_kind" AS ENUM('github_app', 'github_token', 'bitbucket', 'jira');--> statement-breakpoint
CREATE TYPE "public"."project_integration_status" AS ENUM('active', 'paused', 'error');--> statement-breakpoint
CREATE TYPE "public"."project_visibility" AS ENUM('private', 'public');--> statement-breakpoint
CREATE TYPE "public"."secret_kind" AS ENUM('jira_api_key', 'github_token', 'bitbucket_api_token');--> statement-breakpoint
CREATE TYPE "public"."step_definition_kind" AS ENUM('built_in', 'user_defined', 'code');--> statement-breakpoint
CREATE TYPE "public"."step_definition_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."task_kind" AS ENUM('agent', 'code');--> statement-breakpoint
CREATE TYPE "public"."task_lifecycle_status" AS ENUM('queued', 'running', 'waiting_for_person', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."task_log_level" AS ENUM('debug', 'info', 'warn', 'error');--> statement-breakpoint
CREATE TYPE "public"."task_log_stream" AS ENUM('worker', 'ai-server', 'conversation');--> statement-breakpoint
CREATE TYPE "public"."task_run_reason" AS ENUM('initial', 'retry', 'continuation');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('pending', 'queued', 'running', 'succeeded', 'failed', 'timeout', 'abandoned', 'cancelled', 'skipped', 'yielded');--> statement-breakpoint
CREATE TYPE "public"."user_notification_kind" AS ENUM('feedback_request', 'status_update', 'blocked', 'result_ready', 'warning');--> statement-breakpoint
CREATE TYPE "public"."user_notification_status" AS ENUM('pending', 'delivered', 'partially_delivered', 'suppressed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."work_item_comment_author_kind" AS ENUM('user', 'agent');--> statement-breakpoint
CREATE TYPE "public"."work_item_platform" AS ENUM('jira', 'github', 'bitbucket', 'linear', 'scarn', 'custom');--> statement-breakpoint
CREATE TYPE "public"."work_item_state" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TABLE "app"."agent_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_run_id" uuid NOT NULL,
	"conversation_root_id" uuid,
	"parent_agent_session_id" uuid,
	"provider" text NOT NULL,
	"external_session_id" text NOT NULL,
	"status" "agent_session_status" NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."conversation_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"author_kind" "conversation_message_author_kind" NOT NULL,
	"author_user_id" uuid,
	"task_run_id" uuid,
	"delivered_to_task_run_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"work_item_id" uuid,
	"status" "conversation_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app"."github_installations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"account_login" text,
	"account_type" text,
	"target_type" text,
	"selected_repositories_json" jsonb,
	"installed_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."github_relationship_pending_refs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"kind" "github_relationship_ref_kind" NOT NULL,
	"target_platform_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."lane_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"pipeline_run_id" uuid NOT NULL,
	"parent_lane_id" uuid,
	"spawned_by_visit_id" uuid NOT NULL,
	"kind" "lane_group_kind" NOT NULL,
	"lane_count" integer NOT NULL,
	"max_concurrency" integer,
	"tolerated_failures" jsonb NOT NULL,
	"status" "lane_group_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."lanes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"lane_group_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"item_json" jsonb,
	"route" jsonb NOT NULL,
	"origin" "lane_origin" NOT NULL,
	"status" "lane_status" NOT NULL,
	"arrived_at_node_id" text,
	"arrival_args_json" jsonb,
	"arrived_from_visit_id" uuid,
	"arrival_transition" jsonb,
	"merged_into_visit_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."node_visit_questions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"pipeline_run_id" uuid NOT NULL,
	"visit_id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
	"status" "node_visit_question_status" NOT NULL,
	"answer_comment_id" uuid,
	"answered_by_user_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app"."node_visits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"pipeline_run_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"node_kind" "node_visit_kind" NOT NULL,
	"lane_id" uuid,
	"from_visit_id" uuid,
	"from_lane_group_id" uuid,
	"transition" jsonb NOT NULL,
	"routing_json" jsonb,
	"status" "node_visit_status" NOT NULL,
	"input_json" jsonb NOT NULL,
	"task_id" uuid,
	"result_json" jsonb,
	"error_json" jsonb,
	"conversation_id" uuid,
	"created_by_user_id" uuid,
	"resolved_by_user_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app"."notification_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"notification_id" uuid NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"status" "notification_delivery_status" DEFAULT 'pending' NOT NULL,
	"suppression_reason" text,
	"external_url" text,
	"external_id" text,
	"artifact_resolution_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app"."notification_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "user_notification_kind" NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"min_priority" "notification_priority",
	"conditions_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."pipeline_graph_version_steps" (
	"pipeline_graph_version_id" uuid NOT NULL,
	"step_key" text NOT NULL,
	"step_definition_id" uuid NOT NULL,
	CONSTRAINT "pipeline_graph_version_steps_pipeline_graph_version_id_step_key_pk" PRIMARY KEY("pipeline_graph_version_id","step_key")
);
--> statement-breakpoint
CREATE TABLE "app"."pipeline_graph_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"pipeline_graph_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"definition_json" jsonb NOT NULL,
	"schema_version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."pipeline_graphs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"current_version_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."pipeline_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"pipeline_graph_id" uuid NOT NULL,
	"pipeline_graph_version_id" uuid NOT NULL,
	"status" "pipeline_run_status" NOT NULL,
	"end_node_id" text,
	"error_json" jsonb,
	"triggered_by_user_id" uuid,
	"cancelled_by_user_id" uuid,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."project_integrations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "project_integration_kind" NOT NULL,
	"installation_id" text,
	"external_scope_json" jsonb NOT NULL,
	"status" "project_integration_status" DEFAULT 'active' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"first_sync_horizon_days" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_integrations_kind_installation_check" CHECK (("app"."project_integrations"."kind" = 'github_app') = ("app"."project_integrations"."installation_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "app"."project_invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"email" text,
	"role" text NOT NULL,
	"restriction" text NOT NULL,
	"permissions" jsonb NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."project_memberships" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"git_url" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"default_pipeline_assignment_json" jsonb,
	"default_pipeline_id" uuid,
	"default_pipeline_event_type" "default_pipeline_assignment_event_type",
	"default_pipeline_allowed_event_types" "default_pipeline_assignment_event_type"[],
	"default_pipeline_rules_json" jsonb,
	"default_pipeline_event_params_json" jsonb,
	"visibility" "project_visibility" DEFAULT 'private' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."secrets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"kind" "secret_kind" NOT NULL,
	"name" text NOT NULL,
	"metadata_json" jsonb NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"key_version" integer NOT NULL,
	"last_four" text NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."step_definition_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"prompt_template" text,
	"input_schema_json" jsonb,
	"result_schema_json" jsonb,
	"opencode_mcp_json" jsonb,
	"health_checks_json" jsonb,
	"parameters_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."step_definitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"prompt" text,
	"version" integer NOT NULL,
	"kind" "step_definition_kind" NOT NULL,
	"entrypoint_json" jsonb,
	"input_schema_json" jsonb NOT NULL,
	"result_schema_json" jsonb,
	"errors_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"retry_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"task_execution_config_id" uuid,
	"status" "step_definition_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."task_artifact_failures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_run_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"relative_store_path" text NOT NULL,
	"attempted_size_bytes" bigint NOT NULL,
	"kind" text DEFAULT 'generic' NOT NULL,
	"error_code" text NOT NULL,
	"error_message" text NOT NULL,
	"http_status" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."task_artifact_resolutions" (
	"task_run_id" uuid NOT NULL,
	"result_path" text NOT NULL,
	"artifact_id" uuid,
	"unavailable_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_artifact_resolutions_task_run_id_result_path_pk" PRIMARY KEY("task_run_id","result_path")
);
--> statement-breakpoint
CREATE TABLE "app"."task_artifacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_run_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"relative_store_path" text NOT NULL,
	"object_key" text,
	"store_ref" text,
	"size_bytes" bigint,
	"content_type" text,
	"kind" text DEFAULT 'generic' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app"."task_execution_configs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"schema_version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"runtime_json" jsonb,
	"env_json" jsonb,
	"git_json" jsonb,
	"mcp_json" jsonb,
	"health_checks_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_execution_configs_schema_version_check" CHECK ("app"."task_execution_configs"."schema_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "app"."task_log_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_run_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"stream" "task_log_stream" NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"content" text NOT NULL,
	"level" "task_log_level" DEFAULT 'info' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."task_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"quote_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."task_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"reason" "task_run_reason" NOT NULL,
	"project_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"status" "task_status" NOT NULL,
	"result_json" jsonb,
	"error_json" jsonb,
	"session_object_key" text,
	"session_restored" boolean,
	"base_branch" text,
	"work_branch" text,
	"created_from_branch" text,
	"claimed_by" text,
	"claim_token" text,
	"claimed_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"execution_deadline_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"log_archive_store_ref" text,
	"log_archive_size_bytes" bigint,
	"log_archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"step_definition_id" uuid,
	"kind" "task_kind" NOT NULL,
	"name" text,
	"prompt" text,
	"entrypoint_json" jsonb,
	"result_schema_json" jsonb,
	"task_execution_config_id" uuid,
	"input_json" jsonb,
	"retry_json" jsonb,
	"max_turns" integer,
	"heartbeat_seconds" integer,
	"execution_timeout_seconds" integer,
	"status" "task_lifecycle_status" NOT NULL,
	"result_json" jsonb,
	"error_json" jsonb,
	"started_by_user_id" uuid,
	"previous_task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_kind_instructions_check" CHECK (("app"."tasks"."kind" = 'agent' AND "app"."tasks"."prompt" IS NOT NULL AND "app"."tasks"."entrypoint_json" IS NULL) OR ("app"."tasks"."kind" = 'code' AND "app"."tasks"."entrypoint_json" IS NOT NULL AND "app"."tasks"."prompt" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "app"."usage_meters" (
	"org_id" uuid NOT NULL,
	"period" text NOT NULL,
	"plan_id" text NOT NULL,
	"writes" bigint DEFAULT 0 NOT NULL,
	"reads" bigint DEFAULT 0 NOT NULL,
	"storage_bytes" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."user_notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"work_item_id" uuid,
	"pipeline_execution_id" uuid,
	"task_id" uuid,
	"agent_session_id" uuid,
	"kind" "user_notification_kind" NOT NULL,
	"audience" "notification_audience" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"priority" "notification_priority" DEFAULT 'normal' NOT NULL,
	"source" "notification_source" NOT NULL,
	"status" "user_notification_status" DEFAULT 'pending' NOT NULL,
	"payload_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."work_item_blocks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"blocked_work_item_id" uuid NOT NULL,
	"blocking_work_item_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."work_item_comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"author_user_id" uuid,
	"author_kind" "work_item_comment_author_kind" DEFAULT 'user' NOT NULL,
	"agent_session_id" uuid,
	"source_notification_id" uuid,
	"external_comment_id" text,
	"external_comment_url" text,
	"parent_comment_id" uuid,
	"body" text NOT NULL,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."work_item_projection_fingerprints" (
	"work_item_id" uuid NOT NULL,
	"spec_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"canonical_content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."work_item_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"credentials" jsonb NOT NULL,
	"config" jsonb NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_cursor" text,
	"last_sync_status" text,
	"last_sync_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."work_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"platform" "work_item_platform" NOT NULL,
	"platform_id" text,
	"platform_key" text NOT NULL,
	"url" text,
	"title" text NOT NULL,
	"description" text,
	"source_created_at" timestamp with time zone,
	"source_updated_at" timestamp with time zone,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" uuid,
	"parent_work_item_id" uuid,
	"state" "work_item_state" DEFAULT 'open' NOT NULL,
	"spawned_by_task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."agent_sessions" ADD CONSTRAINT "agent_sessions_task_run_id_task_runs_id_fk" FOREIGN KEY ("task_run_id") REFERENCES "app"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_sessions" ADD CONSTRAINT "agent_sessions_conversation_root_id_agent_sessions_id_fk" FOREIGN KEY ("conversation_root_id") REFERENCES "app"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_sessions" ADD CONSTRAINT "agent_sessions_parent_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("parent_agent_session_id") REFERENCES "app"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "app"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."conversation_messages" ADD CONSTRAINT "conversation_messages_task_run_id_task_runs_id_fk" FOREIGN KEY ("task_run_id") REFERENCES "app"."task_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."conversation_messages" ADD CONSTRAINT "conversation_messages_delivered_to_task_run_id_task_runs_id_fk" FOREIGN KEY ("delivered_to_task_run_id") REFERENCES "app"."task_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."conversations" ADD CONSTRAINT "conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."conversations" ADD CONSTRAINT "conversations_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "app"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."github_relationship_pending_refs" ADD CONSTRAINT "github_relationship_pending_refs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."github_relationship_pending_refs" ADD CONSTRAINT "github_relationship_pending_refs_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "app"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."lane_groups" ADD CONSTRAINT "lane_groups_pipeline_run_id_pipeline_runs_id_fk" FOREIGN KEY ("pipeline_run_id") REFERENCES "app"."pipeline_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."lane_groups" ADD CONSTRAINT "lane_groups_parent_lane_id_lanes_id_fk" FOREIGN KEY ("parent_lane_id") REFERENCES "app"."lanes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."lane_groups" ADD CONSTRAINT "lane_groups_spawned_by_visit_id_node_visits_id_fk" FOREIGN KEY ("spawned_by_visit_id") REFERENCES "app"."node_visits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."lanes" ADD CONSTRAINT "lanes_lane_group_id_lane_groups_id_fk" FOREIGN KEY ("lane_group_id") REFERENCES "app"."lane_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."lanes" ADD CONSTRAINT "lanes_arrived_from_visit_id_node_visits_id_fk" FOREIGN KEY ("arrived_from_visit_id") REFERENCES "app"."node_visits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."lanes" ADD CONSTRAINT "lanes_merged_into_visit_id_node_visits_id_fk" FOREIGN KEY ("merged_into_visit_id") REFERENCES "app"."node_visits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."node_visit_questions" ADD CONSTRAINT "node_visit_questions_pipeline_run_id_pipeline_runs_id_fk" FOREIGN KEY ("pipeline_run_id") REFERENCES "app"."pipeline_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."node_visit_questions" ADD CONSTRAINT "node_visit_questions_visit_id_node_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "app"."node_visits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."node_visit_questions" ADD CONSTRAINT "node_visit_questions_comment_id_work_item_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "app"."work_item_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."node_visit_questions" ADD CONSTRAINT "node_visit_questions_answer_comment_id_work_item_comments_id_fk" FOREIGN KEY ("answer_comment_id") REFERENCES "app"."work_item_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."node_visits" ADD CONSTRAINT "node_visits_pipeline_run_id_pipeline_runs_id_fk" FOREIGN KEY ("pipeline_run_id") REFERENCES "app"."pipeline_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."node_visits" ADD CONSTRAINT "node_visits_lane_id_lanes_id_fk" FOREIGN KEY ("lane_id") REFERENCES "app"."lanes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."node_visits" ADD CONSTRAINT "node_visits_from_visit_id_node_visits_id_fk" FOREIGN KEY ("from_visit_id") REFERENCES "app"."node_visits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."node_visits" ADD CONSTRAINT "node_visits_from_lane_group_id_lane_groups_id_fk" FOREIGN KEY ("from_lane_group_id") REFERENCES "app"."lane_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."node_visits" ADD CONSTRAINT "node_visits_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "app"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."node_visits" ADD CONSTRAINT "node_visits_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "app"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_user_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "app"."user_notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."notification_rules" ADD CONSTRAINT "notification_rules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."pipeline_graph_version_steps" ADD CONSTRAINT "pipeline_graph_version_steps_pipeline_graph_version_id_pipeline_graph_versions_id_fk" FOREIGN KEY ("pipeline_graph_version_id") REFERENCES "app"."pipeline_graph_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."pipeline_graph_version_steps" ADD CONSTRAINT "pipeline_graph_version_steps_step_definition_id_step_definitions_id_fk" FOREIGN KEY ("step_definition_id") REFERENCES "app"."step_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."pipeline_graph_versions" ADD CONSTRAINT "pipeline_graph_versions_pipeline_graph_id_pipeline_graphs_id_fk" FOREIGN KEY ("pipeline_graph_id") REFERENCES "app"."pipeline_graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."pipeline_graphs" ADD CONSTRAINT "pipeline_graphs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."pipeline_runs" ADD CONSTRAINT "pipeline_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."pipeline_runs" ADD CONSTRAINT "pipeline_runs_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "app"."work_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."pipeline_runs" ADD CONSTRAINT "pipeline_runs_pipeline_graph_id_pipeline_graphs_id_fk" FOREIGN KEY ("pipeline_graph_id") REFERENCES "app"."pipeline_graphs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."pipeline_runs" ADD CONSTRAINT "pipeline_runs_pipeline_graph_version_id_pipeline_graph_versions_id_fk" FOREIGN KEY ("pipeline_graph_version_id") REFERENCES "app"."pipeline_graph_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."project_integrations" ADD CONSTRAINT "project_integrations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."project_invites" ADD CONSTRAINT "project_invites_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."project_memberships" ADD CONSTRAINT "project_memberships_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."projects" ADD CONSTRAINT "projects_default_pipeline_id_pipeline_graphs_id_fk" FOREIGN KEY ("default_pipeline_id") REFERENCES "app"."pipeline_graphs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."step_definitions" ADD CONSTRAINT "step_definitions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."step_definitions" ADD CONSTRAINT "step_definitions_task_execution_config_id_task_execution_configs_id_fk" FOREIGN KEY ("task_execution_config_id") REFERENCES "app"."task_execution_configs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."task_artifact_failures" ADD CONSTRAINT "task_artifact_failures_task_run_id_task_runs_id_fk" FOREIGN KEY ("task_run_id") REFERENCES "app"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."task_artifact_failures" ADD CONSTRAINT "task_artifact_failures_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."task_artifact_resolutions" ADD CONSTRAINT "task_artifact_resolutions_task_run_id_task_runs_id_fk" FOREIGN KEY ("task_run_id") REFERENCES "app"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."task_artifact_resolutions" ADD CONSTRAINT "task_artifact_resolutions_artifact_id_task_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "app"."task_artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."task_artifacts" ADD CONSTRAINT "task_artifacts_task_run_id_task_runs_id_fk" FOREIGN KEY ("task_run_id") REFERENCES "app"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."task_artifacts" ADD CONSTRAINT "task_artifacts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."task_execution_configs" ADD CONSTRAINT "task_execution_configs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."task_log_lines" ADD CONSTRAINT "task_log_lines_task_run_id_task_runs_id_fk" FOREIGN KEY ("task_run_id") REFERENCES "app"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."task_messages" ADD CONSTRAINT "task_messages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "app"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."task_runs" ADD CONSTRAINT "task_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "app"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."task_runs" ADD CONSTRAINT "task_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."task_runs" ADD CONSTRAINT "task_runs_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "app"."work_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD CONSTRAINT "tasks_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "app"."work_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD CONSTRAINT "tasks_step_definition_id_step_definitions_id_fk" FOREIGN KEY ("step_definition_id") REFERENCES "app"."step_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD CONSTRAINT "tasks_task_execution_config_id_task_execution_configs_id_fk" FOREIGN KEY ("task_execution_config_id") REFERENCES "app"."task_execution_configs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD CONSTRAINT "tasks_previous_task_id_tasks_id_fk" FOREIGN KEY ("previous_task_id") REFERENCES "app"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."user_notifications" ADD CONSTRAINT "user_notifications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."user_notifications" ADD CONSTRAINT "user_notifications_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "app"."work_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."user_notifications" ADD CONSTRAINT "user_notifications_pipeline_execution_id_pipeline_runs_id_fk" FOREIGN KEY ("pipeline_execution_id") REFERENCES "app"."pipeline_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."user_notifications" ADD CONSTRAINT "user_notifications_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "app"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."user_notifications" ADD CONSTRAINT "user_notifications_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "app"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."work_item_blocks" ADD CONSTRAINT "work_item_blocks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."work_item_blocks" ADD CONSTRAINT "work_item_blocks_blocked_work_item_id_work_items_id_fk" FOREIGN KEY ("blocked_work_item_id") REFERENCES "app"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."work_item_blocks" ADD CONSTRAINT "work_item_blocks_blocking_work_item_id_work_items_id_fk" FOREIGN KEY ("blocking_work_item_id") REFERENCES "app"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."work_item_comments" ADD CONSTRAINT "work_item_comments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."work_item_comments" ADD CONSTRAINT "work_item_comments_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "app"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."work_item_comments" ADD CONSTRAINT "work_item_comments_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "app"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."work_item_comments" ADD CONSTRAINT "work_item_comments_source_notification_id_user_notifications_id_fk" FOREIGN KEY ("source_notification_id") REFERENCES "app"."user_notifications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."work_item_comments" ADD CONSTRAINT "work_item_comments_parent_comment_id_work_item_comments_id_fk" FOREIGN KEY ("parent_comment_id") REFERENCES "app"."work_item_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."work_item_projection_fingerprints" ADD CONSTRAINT "work_item_projection_fingerprints_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "app"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."work_item_sources" ADD CONSTRAINT "work_item_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."work_items" ADD CONSTRAINT "work_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."work_items" ADD CONSTRAINT "work_items_parent_work_item_id_work_items_id_fk" FOREIGN KEY ("parent_work_item_id") REFERENCES "app"."work_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."work_items" ADD CONSTRAINT "work_items_spawned_by_task_id_tasks_id_fk" FOREIGN KEY ("spawned_by_task_id") REFERENCES "app"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_sessions_task_run_id_idx" ON "app"."agent_sessions" USING btree ("task_run_id");--> statement-breakpoint
CREATE INDEX "agent_sessions_conversation_root_id_idx" ON "app"."agent_sessions" USING btree ("conversation_root_id");--> statement-breakpoint
CREATE INDEX "agent_sessions_parent_agent_session_id_idx" ON "app"."agent_sessions" USING btree ("parent_agent_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sessions_provider_external_session_id_unique" ON "app"."agent_sessions" USING btree ("provider","external_session_id");--> statement-breakpoint
CREATE INDEX "conversation_messages_conversation_id_created_at_idx" ON "app"."conversation_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "conversation_messages_task_run_id_idx" ON "app"."conversation_messages" USING btree ("task_run_id");--> statement-breakpoint
CREATE INDEX "conversations_project_id_idx" ON "app"."conversations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "conversations_work_item_id_idx" ON "app"."conversations" USING btree ("work_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_installations_installation_id_unique" ON "app"."github_installations" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "github_installations_installed_by_user_id_idx" ON "app"."github_installations" USING btree ("installed_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_relationship_pending_refs_unique" ON "app"."github_relationship_pending_refs" USING btree ("work_item_id","kind","target_platform_key");--> statement-breakpoint
CREATE INDEX "github_relationship_pending_refs_project_id_idx" ON "app"."github_relationship_pending_refs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "lane_groups_pipeline_run_id_idx" ON "app"."lane_groups" USING btree ("pipeline_run_id");--> statement-breakpoint
CREATE INDEX "lane_groups_spawned_by_visit_id_idx" ON "app"."lane_groups" USING btree ("spawned_by_visit_id");--> statement-breakpoint
CREATE INDEX "lane_groups_parent_lane_id_idx" ON "app"."lane_groups" USING btree ("parent_lane_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lanes_group_index_unique" ON "app"."lanes" USING btree ("lane_group_id","index");--> statement-breakpoint
CREATE UNIQUE INDEX "node_visit_questions_comment_id_unique" ON "app"."node_visit_questions" USING btree ("comment_id");--> statement-breakpoint
CREATE INDEX "node_visit_questions_visit_id_idx" ON "app"."node_visit_questions" USING btree ("visit_id");--> statement-breakpoint
CREATE INDEX "node_visit_questions_pipeline_run_id_idx" ON "app"."node_visit_questions" USING btree ("pipeline_run_id");--> statement-breakpoint
CREATE INDEX "node_visits_pipeline_run_id_idx" ON "app"."node_visits" USING btree ("pipeline_run_id");--> statement-breakpoint
CREATE INDEX "node_visits_pipeline_run_node_id_idx" ON "app"."node_visits" USING btree ("pipeline_run_id","node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "node_visits_task_id_unique" ON "app"."node_visits" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "node_visits_conversation_id_unique" ON "app"."node_visits" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "notification_deliveries_notification_id_idx" ON "app"."notification_deliveries" USING btree ("notification_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_notification_channel_unique" ON "app"."notification_deliveries" USING btree ("notification_id","channel");--> statement-breakpoint
CREATE INDEX "notification_rules_project_id_idx" ON "app"."notification_rules" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_rules_project_kind_channel_unique" ON "app"."notification_rules" USING btree ("project_id","kind","channel");--> statement-breakpoint
CREATE INDEX "pipeline_graph_version_steps_step_definition_id_idx" ON "app"."pipeline_graph_version_steps" USING btree ("step_definition_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_graph_versions_graph_version_unique" ON "app"."pipeline_graph_versions" USING btree ("pipeline_graph_id","version");--> statement-breakpoint
CREATE INDEX "pipeline_graph_versions_graph_id_idx" ON "app"."pipeline_graph_versions" USING btree ("pipeline_graph_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_graphs_project_key_unique" ON "app"."pipeline_graphs" USING btree ("project_id","key") WHERE "app"."pipeline_graphs"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "pipeline_graphs_project_id_idx" ON "app"."pipeline_graphs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "pipeline_graphs_project_active_idx" ON "app"."pipeline_graphs" USING btree ("project_id") WHERE "app"."pipeline_graphs"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "pipeline_runs_project_id_idx" ON "app"."pipeline_runs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "pipeline_runs_project_created_at_idx" ON "app"."pipeline_runs" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "pipeline_runs_pipeline_graph_id_idx" ON "app"."pipeline_runs" USING btree ("pipeline_graph_id");--> statement-breakpoint
CREATE INDEX "pipeline_runs_pipeline_graph_version_id_idx" ON "app"."pipeline_runs" USING btree ("pipeline_graph_version_id");--> statement-breakpoint
CREATE INDEX "pipeline_runs_work_item_id_idx" ON "app"."pipeline_runs" USING btree ("work_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_integrations_project_github_app_install_unique" ON "app"."project_integrations" USING btree ("project_id","installation_id") WHERE "app"."project_integrations"."kind" = 'github_app';--> statement-breakpoint
CREATE INDEX "project_integrations_project_id_idx" ON "app"."project_integrations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_integrations_installation_id_idx" ON "app"."project_integrations" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "project_invites_project_id_idx" ON "app"."project_invites" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_invites_project_email_status_idx" ON "app"."project_invites" USING btree ("project_id","email","status");--> statement-breakpoint
CREATE INDEX "project_invites_project_restriction_status_idx" ON "app"."project_invites" USING btree ("project_id","restriction","status");--> statement-breakpoint
CREATE UNIQUE INDEX "project_invites_token_hash_unique" ON "app"."project_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "project_memberships_project_user_unique" ON "app"."project_memberships" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE INDEX "project_memberships_project_id_idx" ON "app"."project_memberships" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_memberships_user_id_idx" ON "app"."project_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "projects_created_by_user_id_idx" ON "app"."projects" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "projects_org_id_idx" ON "app"."projects" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_org_id_slug_unique" ON "app"."projects" USING btree ("org_id","slug");--> statement-breakpoint
CREATE INDEX "secrets_owner_user_id_idx" ON "app"."secrets" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "secrets_owner_user_kind_name_unique" ON "app"."secrets" USING btree ("owner_user_id","kind","name");--> statement-breakpoint
CREATE UNIQUE INDEX "step_definition_templates_key_unique" ON "app"."step_definition_templates" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "step_definitions_project_key_version_unique" ON "app"."step_definitions" USING btree ("project_id","key","version");--> statement-breakpoint
CREATE INDEX "step_definitions_project_id_idx" ON "app"."step_definitions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "step_definitions_project_key_idx" ON "app"."step_definitions" USING btree ("project_id","key");--> statement-breakpoint
CREATE INDEX "step_definitions_task_execution_config_id_idx" ON "app"."step_definitions" USING btree ("task_execution_config_id");--> statement-breakpoint
CREATE INDEX "task_artifact_failures_task_run_created_idx" ON "app"."task_artifact_failures" USING btree ("task_run_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "task_artifact_resolutions_artifact_id_idx" ON "app"."task_artifact_resolutions" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "task_artifacts_task_run_id_idx" ON "app"."task_artifacts" USING btree ("task_run_id");--> statement-breakpoint
CREATE INDEX "task_artifacts_created_at_idx" ON "app"."task_artifacts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "task_artifacts_project_id_idx" ON "app"."task_artifacts" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "task_artifacts_project_deleted_idx" ON "app"."task_artifacts" USING btree ("project_id","deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_execution_configs_project_content_hash_unique" ON "app"."task_execution_configs" USING btree ("project_id","content_hash");--> statement-breakpoint
CREATE INDEX "task_execution_configs_project_id_idx" ON "app"."task_execution_configs" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_log_lines_task_run_seq_unique" ON "app"."task_log_lines" USING btree ("task_run_id","seq");--> statement-breakpoint
CREATE INDEX "task_log_lines_task_run_seq_idx" ON "app"."task_log_lines" USING btree ("task_run_id","seq");--> statement-breakpoint
CREATE INDEX "task_messages_task_id_idx" ON "app"."task_messages" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_runs_project_id_idx" ON "app"."task_runs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "task_runs_status_idx" ON "app"."task_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "task_runs_log_archived_at_idx" ON "app"."task_runs" USING btree ("log_archived_at");--> statement-breakpoint
CREATE INDEX "task_runs_work_item_id_idx" ON "app"."task_runs" USING btree ("work_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_runs_task_id_number_unique" ON "app"."task_runs" USING btree ("task_id","number");--> statement-breakpoint
CREATE INDEX "tasks_project_id_idx" ON "app"."tasks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "tasks_work_item_id_idx" ON "app"."tasks" USING btree ("work_item_id");--> statement-breakpoint
CREATE INDEX "tasks_status_idx" ON "app"."tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tasks_step_definition_id_idx" ON "app"."tasks" USING btree ("step_definition_id");--> statement-breakpoint
CREATE INDEX "tasks_task_execution_config_id_idx" ON "app"."tasks" USING btree ("task_execution_config_id");--> statement-breakpoint
CREATE INDEX "tasks_previous_task_id_idx" ON "app"."tasks" USING btree ("previous_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_meters_org_period_unique" ON "app"."usage_meters" USING btree ("org_id","period");--> statement-breakpoint
CREATE INDEX "usage_meters_org_id_idx" ON "app"."usage_meters" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "user_notifications_project_id_idx" ON "app"."user_notifications" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "user_notifications_work_item_id_idx" ON "app"."user_notifications" USING btree ("work_item_id");--> statement-breakpoint
CREATE INDEX "user_notifications_project_status_idx" ON "app"."user_notifications" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "work_item_blocks_pair_unique" ON "app"."work_item_blocks" USING btree ("blocked_work_item_id","blocking_work_item_id");--> statement-breakpoint
CREATE INDEX "work_item_blocks_blocked_idx" ON "app"."work_item_blocks" USING btree ("blocked_work_item_id");--> statement-breakpoint
CREATE INDEX "work_item_blocks_blocking_idx" ON "app"."work_item_blocks" USING btree ("blocking_work_item_id");--> statement-breakpoint
CREATE INDEX "work_item_comments_work_item_id_idx" ON "app"."work_item_comments" USING btree ("work_item_id");--> statement-breakpoint
CREATE INDEX "work_item_comments_project_id_idx" ON "app"."work_item_comments" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "work_item_comments_parent_comment_id_idx" ON "app"."work_item_comments" USING btree ("parent_comment_id");--> statement-breakpoint
CREATE INDEX "work_item_comments_work_item_pinned_idx" ON "app"."work_item_comments" USING btree ("work_item_id") WHERE "app"."work_item_comments"."is_pinned";--> statement-breakpoint
CREATE UNIQUE INDEX "work_item_projection_fingerprints_work_item_spec_unique" ON "app"."work_item_projection_fingerprints" USING btree ("work_item_id","spec_id");--> statement-breakpoint
CREATE INDEX "work_item_sources_project_id_idx" ON "app"."work_item_sources" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "work_item_sources_kind_idx" ON "app"."work_item_sources" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "work_item_sources_is_active_idx" ON "app"."work_item_sources" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "work_items_project_platform_platform_key_unique" ON "app"."work_items" USING btree ("project_id","platform","platform_key");--> statement-breakpoint
CREATE INDEX "work_items_project_id_idx" ON "app"."work_items" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "work_items_platform_key_idx" ON "app"."work_items" USING btree ("platform_key");--> statement-breakpoint
CREATE INDEX "work_items_parent_work_item_id_idx" ON "app"."work_items" USING btree ("parent_work_item_id");--> statement-breakpoint
CREATE INDEX "work_items_project_state_idx" ON "app"."work_items" USING btree ("project_id","state");--> statement-breakpoint
CREATE INDEX "work_items_spawned_by_task_id_idx" ON "app"."work_items" USING btree ("spawned_by_task_id");--> statement-breakpoint
CREATE INDEX "work_items_project_source_updated_idx" ON "app"."work_items" USING btree ("project_id",coalesce("source_updated_at", "updated_at") desc);--> statement-breakpoint
CREATE INDEX "work_items_project_created_idx" ON "app"."work_items" USING btree ("project_id","created_at" desc);
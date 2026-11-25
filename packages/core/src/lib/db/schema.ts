/* eslint-disable max-lines */
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const workItemPlatformEnum = pgEnum("work_item_platform", [
  "jira",
  "github",
  "bitbucket",
  "linear",
  "scarn",
  "custom",
]);

// `code` added for the flat-pipeline-SDK's code-step kind (a plain function
// instead of an LLM prompt — see `step_definitions.entrypoint_json` below).
// `built_in` stays dormant, reserved for a future first-party/
// shipped-by-Scarn meaning.
export const stepDefinitionKindEnum = pgEnum("step_definition_kind", [
  "built_in",
  "user_defined",
  "code",
  "mcp_tool",
]);

// `private` (default) restricts reads/writes to project members, exactly as
// today. `public` grants read-only access to any actor, including one with
// no session at all — see `assertProjectPermission`. There is no HTTP route
// that sets this to `public`; it is only ever set by internal tooling (e.g.
// the demo-project seed script).
export const projectVisibilityEnum = pgEnum("project_visibility", [
  "private",
  "public",
]);

export const stepDefinitionStatusEnum = pgEnum("step_definition_status", [
  "draft",
  "active",
  "archived",
]);

export const taskLogStreamEnum = pgEnum("task_log_stream", [
  "worker",
  "ai-server",
  "conversation",
]);

export const taskLogLevelEnum = pgEnum("task_log_level", [
  "debug",
  "info",
  "warn",
  "error",
]);

export const pipelineRunStatusEnum = pgEnum("pipeline_run_status", [
  "active",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
]);

export const nodeVisitKindEnum = pgEnum("node_visit_kind", [
  "step",
  "wait",
  "succeed",
  "fail",
]);

export const nodeVisitStatusEnum = pgEnum("node_visit_status", [
  "active",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
  "superseded",
]);

export const nodeVisitQuestionStatusEnum = pgEnum(
  "node_visit_question_status",
  ["open", "answered", "not_needed"],
);

export const laneGroupStatusEnum = pgEnum("lane_group_status", [
  "open",
  "merged",
  "failed",
]);

export const laneGroupKindEnum = pgEnum("lane_group_kind", ["each", "all"]);

export const laneOriginEnum = pgEnum("lane_origin", ["split", "merge"]);

export const laneStatusEnum = pgEnum("lane_status", [
  "pending",
  "active",
  "arrived",
  "ended",
  "failed",
  "cancelled",
]);

// `pending` is unused by the engine today; `TaskRunEntity` does not model it.
// `yielded`: the agent ended its turn and handed the conversation to a person
// (its final message is a `conversation_messages` row). It is terminal for the
// row; the reply starts the Task's next TaskRun, the continuation.
export const taskStatusEnum = pgEnum("task_status", [
  "pending",
  "queued",
  "running",
  "succeeded",
  "failed",
  "timeout",
  "abandoned",
  "cancelled",
  "skipped",
  "yielded",
]);

export const taskKindEnum = pgEnum("task_kind", ["agent", "code", "mcp_tool"]);

/** A Task's own status, separate from its runs' `task_status`. */
export const taskLifecycleStatusEnum = pgEnum("task_lifecycle_status", [
  "waiting_for_concurrency_slot",
  "waiting_for_work",
  "queued",
  "running",
  "waiting_for_person",
  "succeeded",
  "failed",
  "cancelled",
]);

/** Why a TaskRun was started: the Task's first run, a retry, or a continuation after a hand-over. */
export const taskRunReasonEnum = pgEnum("task_run_reason", [
  "initial",
  "retry",
  "continuation",
]);

export const conversationStatusEnum = pgEnum("conversation_status", [
  "agent_turn",
  "waiting_for_person",
  "reply_pending",
  "closed",
]);

export const conversationMessageAuthorKindEnum = pgEnum(
  "conversation_message_author_kind",
  ["agent", "person", "system"],
);

export const agentSessionStatusEnum = pgEnum("agent_session_status", [
  "running",
  "ended",
  "failed",
]);

export const workItemStateEnum = pgEnum("work_item_state", ["open", "closed"]);

export const automationScopeEnum = pgEnum("automation_scope", [
  "workItem",
  "project",
]);

export const workItemCloseReasonEnum = pgEnum("work_item_close_reason", [
  "completed",
  "out_of_scope",
  "superseded",
]);

export const userNotificationKindEnum = pgEnum("user_notification_kind", [
  "feedback_request",
  "status_update",
  "blocked",
  "result_ready",
  "warning",
  "integration_auto_sync_paused",
]);

export const notificationAudienceEnum = pgEnum("notification_audience", [
  "assignee",
  "reporter",
  "project_admins",
  "specific_users",
]);

export const notificationPriorityEnum = pgEnum("notification_priority", [
  "low",
  "normal",
  "high",
  "urgent",
]);

export const notificationSourceEnum = pgEnum("notification_source", [
  "agent",
  "system",
  "user",
]);

export const userNotificationStatusEnum = pgEnum("user_notification_status", [
  "pending",
  "delivered",
  "partially_delivered",
  "suppressed",
  "failed",
]);

export const notificationChannelEnum = pgEnum("notification_channel", [
  "in_app",
  "work_item_platform_comment",
  "email",
  "slack",
]);

export const notificationDeliveryStatusEnum = pgEnum(
  "notification_delivery_status",
  ["pending", "sent", "failed", "suppressed"],
);

export const appSchema = pgSchema("app");

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

const createdAtColumn = () =>
  timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

const updatedAtColumn = () =>
  timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull();

export const projects = appSchema.table(
  "projects",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    // URL slug, unique within the owning org. Derived from `name` at creation
    // (slugify + de-dup within org). Powers pretty URLs `/{username}/{slug}`.
    slug: text("slug").notNull(),
    description: text("description"),
    gitUrl: text("git_url").notNull(),
    createdByUserId: uuid("created_by_user_id").notNull(),
    // Owning organization (tenancy/billing boundary). References
    // `identity.organization.id` by uuid value WITHOUT a cross-schema FK, the
    // same convention used for `created_by_user_id` -> `identity.user`.
    // NOT NULL now that existing rows have been backfilled and `createProject`
    // always resolves the owning org before insert.
    orgId: uuid("org_id").notNull(),
    visibility: projectVisibilityEnum("visibility")
      .notNull()
      .default("private"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    index("projects_created_by_user_id_idx").on(table.createdByUserId),
    index("projects_org_id_idx").on(table.orgId),
    uniqueIndex("projects_org_id_slug_unique").on(table.orgId, table.slug),
  ],
);

export const projectMemberships = appSchema.table(
  "project_memberships",
  {
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    userId: uuid("user_id").notNull(),
    role: text("role").notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("project_memberships_project_user_unique").on(
      table.projectId,
      table.userId,
    ),
    index("project_memberships_project_id_idx").on(table.projectId),
    index("project_memberships_user_id_idx").on(table.userId),
  ],
);

export const workItems = appSchema.table(
  "work_items",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    platform: workItemPlatformEnum("platform").notNull(),
    platformId: text("platform_id"),
    platformKey: text("platform_key").notNull(),
    url: text("url"),
    title: text("title").notNull(),
    description: text("description"),
    // Goes up on every description write (person, sync or agent) so an
    // agent's write can be refused when someone wrote it since it read it.
    descriptionVersion: integer("description_version").notNull().default(1),
    sourceCreatedAt: timestamp("source_created_at", { withTimezone: true }),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    fields: jsonb("fields").notNull().default({}),
    labels: text("labels")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // Creating user (authenticated actor). Nullable because synced/legacy rows
    // may not have one. References `identity.user.id` by uuid value WITHOUT a
    // cross-schema FK, matching `work_item_comments.author_user_id` and
    // `projects.created_by_user_id`.
    createdByUserId: uuid("created_by_user_id"),
    // The project member responsible for the item; null when unassigned.
    // Same no-FK convention as `created_by_user_id`. Sync never sets it.
    assigneeUserId: uuid("assignee_user_id"),
    // Self-referential parent link for the child/parent work-item hierarchy.
    // `onDelete: "set null"` orphans/promotes children rather than
    // cascade-deleting them when their parent is deleted.
    parentWorkItemId: uuid("parent_work_item_id").references(
      (): AnyPgColumn => workItems.id,
      { onDelete: "set null" },
    ),
    state: workItemStateEnum("state").notNull().default("open"),
    // Set together when the item closes and cleared when it reopens. A sync
    // close is `completed` with no resolution and no closer.
    closeReason: workItemCloseReasonEnum("close_reason"),
    resolution: text("resolution"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedByUserId: uuid("closed_by_user_id"),
    closedByTaskId: uuid("closed_by_task_id").references(
      (): AnyPgColumn => tasks.id,
      { onDelete: "set null" },
    ),
    // The agent Task that created this work item (D-15); null for
    // human-created or synced items.
    spawnedByTaskId: uuid("spawned_by_task_id").references(
      (): AnyPgColumn => tasks.id,
      { onDelete: "set null" },
    ),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("work_items_project_platform_platform_key_unique").on(
      table.projectId,
      table.platform,
      table.platformKey,
    ),
    index("work_items_project_id_idx").on(table.projectId),
    index("work_items_platform_key_idx").on(table.platformKey),
    index("work_items_parent_work_item_id_idx").on(table.parentWorkItemId),
    index("work_items_project_state_idx").on(table.projectId, table.state),
    index("work_items_spawned_by_task_id_idx").on(table.spawnedByTaskId),
    index("work_items_labels_idx").using("gin", table.labels),
    check(
      "work_items_closure_matches_state_check",
      sql`(${table.state} = 'closed' and ${table.closeReason} is not null and ${table.closedAt} is not null) or (${table.state} = 'open' and ${table.closeReason} is null and ${table.resolution} is null and ${table.closedAt} is null and ${table.closedByUserId} is null and ${table.closedByTaskId} is null)`,
    ),
    // Serves both halves of the work item listing: the default
    // `ORDER BY coalesce(source_updated_at, updated_at) DESC` on every page
    // load, and the `updated` filter's range scan. The expression must stay
    // character-identical to `EFFECTIVE_UPDATED_AT` in
    // `work-item-listing-query.ts` or the planner will not match it.
    index("work_items_project_source_updated_idx").on(
      table.projectId,
      sql`coalesce("source_updated_at", "updated_at") desc`,
    ),
    // Serves the `created` sort axis's `ORDER BY created_at desc` (decision 9,
    // `docs/plans/work-item-sort.md`). Generated as a migration but
    // deliberately not yet applied to any database — decision 10 requires
    // proving the planner actually uses it against a realistic seed first;
    // see that plan's Phase 1 section and this repo's follow-up notes.
    index("work_items_project_created_idx").on(
      table.projectId,
      sql`"created_at" desc`,
    ),
  ],
);

export const workItemBlocks = appSchema.table(
  "work_item_blocks",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    // The item that cannot proceed until the blocker is resolved.
    blockedWorkItemId: uuid("blocked_work_item_id")
      .references(() => workItems.id, { onDelete: "cascade" })
      .notNull(),
    // The item that must be resolved first.
    blockingWorkItemId: uuid("blocking_work_item_id")
      .references(() => workItems.id, { onDelete: "cascade" })
      .notNull(),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex("work_item_blocks_pair_unique").on(
      table.blockedWorkItemId,
      table.blockingWorkItemId,
    ),
    index("work_item_blocks_blocked_idx").on(table.blockedWorkItemId),
    index("work_item_blocks_blocking_idx").on(table.blockingWorkItemId),
  ],
);

export const workItemActivityKindEnum = pgEnum("work_item_activity_kind", [
  "automation",
]);

/**
 * One line of a work item's activity: something the system did about the
 * item (today only what an automation started, skipped or failed to start).
 */
export const workItemActivity = appSchema.table(
  "work_item_activity",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    workItemId: uuid("work_item_id")
      .references(() => workItems.id, { onDelete: "cascade" })
      .notNull(),
    kind: workItemActivityKindEnum("kind").notNull(),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("work_item_activity_work_item_idx").on(
      table.workItemId,
      table.createdAt,
    ),
  ],
);

export const githubRelationshipRefKindEnum = pgEnum(
  "github_relationship_ref_kind",
  ["parent", "blocked_by"],
);

export const githubRelationshipPendingRefs = appSchema.table(
  "github_relationship_pending_refs",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    // The work item that HOLDS the unresolved reference (the child, for a
    // "parent" row; the blocked item, for a "blocked_by" row).
    workItemId: uuid("work_item_id")
      .references(() => workItems.id, { onDelete: "cascade" })
      .notNull(),
    kind: githubRelationshipRefKindEnum("kind").notNull(),
    // Raw target platform key, e.g. "owner/repo#128" — same format as
    // `workItems.platformKey`, resolved the same way via
    // `loadManyByPlatformIdentities`.
    targetPlatformKey: text("target_platform_key").notNull(),
    discoveredAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex("github_relationship_pending_refs_unique").on(
      table.workItemId,
      table.kind,
      table.targetPlatformKey,
    ),
    index("github_relationship_pending_refs_project_id_idx").on(
      table.projectId,
    ),
  ],
);

// Distinguishes a comment authored by a project member from one promoted
// from an agent-drafted `comment_draft` notification (see
// `docs/plans/agent-drafted-comment-approval.md`) — `authorUserId` is only
// null for `agent` rows, see `workItemComments.authorUserId` below.
export const workItemCommentAuthorKindEnum = pgEnum(
  "work_item_comment_author_kind",
  ["user", "agent"],
);

export const workItemComments = appSchema.table(
  "work_item_comments",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    workItemId: uuid("work_item_id")
      .references(() => workItems.id, { onDelete: "cascade" })
      .notNull(),
    // Nullable: null iff `authorKind` is `agent` (a promoted comment_draft
    // has no project-member author).
    authorUserId: uuid("author_user_id"),
    authorKind: workItemCommentAuthorKindEnum("author_kind")
      .notNull()
      .default("user"),
    // Set only on `agent`-authored rows: the agent session that drafted the
    // originating notification, copied from `userNotifications.agentSessionId`.
    // `agentSessions` is declared later in this file, hence the function form.
    agentSessionId: uuid("agent_session_id").references(
      (): AnyPgColumn => agentSessions.id,
      { onDelete: "set null" },
    ),
    // Traceability back to the `comment_draft` notification this comment was
    // promoted from, once approved. `userNotifications` is declared later in
    // this file, so the function form defers resolution.
    sourceNotificationId: uuid("source_notification_id").references(
      (): AnyPgColumn => userNotifications.id,
      { onDelete: "set null" },
    ),
    // GitHub's comment id/`html_url` once posted, mirroring
    // `notificationDeliveries.externalId`/`externalUrl`.
    externalCommentId: text("external_comment_id"),
    externalCommentUrl: text("external_comment_url"),
    // Set only on `agent` rows an agent Task posted itself; its name is
    // resolved at read time. `tasks` is declared later in this file.
    authoredByTaskId: uuid("authored_by_task_id").references(
      (): AnyPgColumn => tasks.id,
      { onDelete: "set null" },
    ),
    // A reply's top-level parent on the same work item; null for top-level
    // comments. Replies are one level deep.
    parentCommentId: uuid("parent_comment_id").references(
      (): AnyPgColumn => workItemComments.id,
      { onDelete: "cascade" },
    ),
    body: text("body").notNull(),
    isPinned: boolean("is_pinned").notNull().default(false),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    index("work_item_comments_work_item_id_idx").on(table.workItemId),
    index("work_item_comments_work_item_page_idx").on(
      table.workItemId,
      table.isPinned.desc(),
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index("work_item_comments_project_id_idx").on(table.projectId),
    index("work_item_comments_parent_comment_id_idx").on(table.parentCommentId),
    index("work_item_comments_work_item_pinned_idx")
      .on(table.workItemId)
      .where(sql`${table.isPinned}`),
  ],
);

export const workItemProjectionFingerprints = appSchema.table(
  "work_item_projection_fingerprints",
  {
    workItemId: uuid("work_item_id")
      .references(() => workItems.id, { onDelete: "cascade" })
      .notNull(),
    specId: text("spec_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    canonicalContent: text("canonical_content").notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("work_item_projection_fingerprints_work_item_spec_unique").on(
      table.workItemId,
      table.specId,
    ),
  ],
);

/**
 * Immutable, per-project-deduplicated overrides a step definition or Task
 * runs with on top of the repo's own config (D2, D6, D7). `schema_version` is
 * the version of the JSON columns' shape; `content_hash` is the sha256 of
 * their canonical JSON in the current version's shape.
 */
export const taskExecutionConfigs = appSchema.table(
  "task_execution_configs",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    schemaVersion: integer("schema_version").notNull(),
    contentHash: text("content_hash").notNull(),
    environmentJson: jsonb("environment_json"),
    gitJson: jsonb("git_json"),
    mcpJson: jsonb("mcp_json"),
    healthChecksJson: jsonb("health_checks_json"),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex("task_execution_configs_project_content_hash_unique").on(
      table.projectId,
      table.contentHash,
    ),
    index("task_execution_configs_project_id_idx").on(table.projectId),
    check(
      "task_execution_configs_schema_version_check",
      sql`${table.schemaVersion} >= 1`,
    ),
  ],
);

export const stepDefinitions = appSchema.table(
  "step_definitions",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    prompt: text("prompt"),
    version: integer("version").notNull(),
    kind: stepDefinitionKindEnum("kind").notNull(),
    // `{sourceFile}` for a `kind: "code"` step only — see
    // `StepDefinitionEntity`'s kind-specific constructor validation.
    entrypointJson: jsonb("entrypoint_json"),
    // `{ server, tool, argsTemplate, toolSchemas }` for a `kind: "mcp_tool"`
    // step only.
    toolCallJson: jsonb("tool_call_json"),
    inputSchemaJson: jsonb("input_schema_json").notNull(),
    // Null: a conversation step (agent steps only), whose result is
    // `{ conversationId, summary }`.
    resultSchemaJson: jsonb("result_schema_json"),
    // The error names the step declares, which `retry.on`/`catch.on` in a
    // pipeline document are checked against.
    errorsJson: jsonb("errors_json").notNull().default([]),
    // The `retry` list a standalone Task of this step copies onto its
    // `retry_json`; the same shape as a pipeline node's `retry`.
    retryJson: jsonb("retry_json").notNull().default([]),
    // The grants (`Grant[]`) a Task of this step copies onto
    // `tasks.grants_json`, plus `read` on `self`.
    grantsJson: jsonb("grants_json").notNull().default([]),
    // How many times a standalone Task of this step may hand over; null
    // takes the default (`DEFAULT_STANDALONE_MAX_TURNS`).
    maxTurns: integer("max_turns"),
    // `{ max, waiting }`: at most `max` live Tasks of this step per work
    // item, up to `waiting` more in `waiting_for_concurrency_slot`; null for
    // no limit.
    concurrencyJson: jsonb("concurrency_json"),
    // Version of the row's JSON columns; see `step-definition-stored.ts`.
    schemaVersion: integer("schema_version").notNull(),
    taskExecutionConfigId: uuid("task_execution_config_id").references(
      () => taskExecutionConfigs.id,
      { onDelete: "restrict" },
    ),
    status: stepDefinitionStatusEnum("status").notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("step_definitions_project_key_version_unique").on(
      table.projectId,
      table.key,
      table.version,
    ),
    index("step_definitions_project_id_idx").on(table.projectId),
    index("step_definitions_project_key_idx").on(table.projectId, table.key),
    index("step_definitions_task_execution_config_id_idx").on(
      table.taskExecutionConfigId,
    ),
    check(
      "step_definitions_schema_version_check",
      sql`${table.schemaVersion} >= 1`,
    ),
  ],
);

/**
 * A project's named environments. Deleting is soft (`deleted_at`); a deleted
 * name can be published again and keeps its row, so version numbers carry on.
 */
export const environments = appSchema.table(
  "environments",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    latestVersion: integer("latest_version").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("environments_project_name_unique").on(
      table.projectId,
      table.name,
    ),
  ],
);

/**
 * Immutable versions of a named environment. `schema_version` is the version
 * of `content_json`'s shape; `content_hash` is the sha256 of its canonical
 * JSON in the current version's shape.
 */
export const environmentVersions = appSchema.table(
  "environment_versions",
  {
    id: uuid("id").primaryKey(),
    environmentId: uuid("environment_id")
      .references(() => environments.id, { onDelete: "cascade" })
      .notNull(),
    version: integer("version").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    contentJson: jsonb("content_json").notNull(),
    contentHash: text("content_hash").notNull(),
    createdByUserId: uuid("created_by_user_id").notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex("environment_versions_environment_version_unique").on(
      table.environmentId,
      table.version,
    ),
    check(
      "environment_versions_schema_version_check",
      sql`${table.schemaVersion} >= 1`,
    ),
  ],
);

// --- Pipeline definitions: a pipeline is a series of immutable versions,
// each one validated JSON document pinned to specific step versions.

export const pipelineGraphs = appSchema.table(
  "pipeline_graphs",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    currentVersionId: uuid("current_version_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("pipeline_graphs_project_key_unique")
      .on(table.projectId, table.key)
      .where(sql`${table.archivedAt} IS NULL`),
    index("pipeline_graphs_project_id_idx").on(table.projectId),
    index("pipeline_graphs_project_active_idx")
      .on(table.projectId)
      .where(sql`${table.archivedAt} IS NULL`),
  ],
);

export const pipelineGraphVersions = appSchema.table(
  "pipeline_graph_versions",
  {
    id: uuid("id").primaryKey(),
    pipelineGraphId: uuid("pipeline_graph_id")
      .references(() => pipelineGraphs.id, { onDelete: "cascade" })
      .notNull(),
    version: integer("version").notNull(),
    definitionJson: jsonb("definition_json").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    // sha256 of the canonical document plus the pinned step versions.
    contentHash: text("content_hash").notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex("pipeline_graph_versions_graph_version_unique").on(
      table.pipelineGraphId,
      table.version,
    ),
    index("pipeline_graph_versions_graph_id_idx").on(table.pipelineGraphId),
    check(
      "pipeline_graph_versions_schema_version_check",
      sql`${table.schemaVersion} >= 1`,
    ),
  ],
);

export const pipelineGraphVersionSteps = appSchema.table(
  "pipeline_graph_version_steps",
  {
    pipelineGraphVersionId: uuid("pipeline_graph_version_id")
      .references(() => pipelineGraphVersions.id, { onDelete: "cascade" })
      .notNull(),
    stepKey: text("step_key").notNull(),
    stepDefinitionId: uuid("step_definition_id")
      .references(() => stepDefinitions.id, { onDelete: "restrict" })
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.pipelineGraphVersionId, table.stepKey],
    }),
    index("pipeline_graph_version_steps_step_definition_id_idx").on(
      table.stepDefinitionId,
    ),
  ],
);

/**
 * An automation: rules that start steps and pipelines when work item events
 * happen. Each publish of a changed document adds an `automation_versions`
 * row; the latest one is the one that runs. `enabled` only applies to
 * project automations (a work-item automation runs where it's attached).
 */
export const automations = appSchema.table(
  "automations",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    key: text("key").notNull(),
    title: text("title"),
    scope: automationScopeEnum("scope").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("automations_project_key_unique").on(
      table.projectId,
      table.key,
    ),
  ],
);

export const automationVersions = appSchema.table(
  "automation_versions",
  {
    id: uuid("id").primaryKey(),
    automationId: uuid("automation_id")
      .references(() => automations.id, { onDelete: "cascade" })
      .notNull(),
    version: integer("version").notNull(),
    document: jsonb("document").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    // sha256 of the canonical document.
    contentHash: text("content_hash").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("automation_versions_automation_version_unique").on(
      table.automationId,
      table.version,
    ),
  ],
);

/**
 * A `schedule` rule of a project automation, mirrored from its latest
 * published version so the tick can find due schedules. Publishing syncs
 * rows by rule key; a removed key sets `removed_at`, and publishing it again
 * inserts a new row. Rows are never deleted on their own.
 */
export const automationSchedules = appSchema.table(
  "automation_schedules",
  {
    id: uuid("id").primaryKey(),
    automationId: uuid("automation_id")
      .references(() => automations.id, { onDelete: "cascade" })
      .notNull(),
    key: text("key").notNull(),
    cron: text("cron").notNull(),
    timezone: text("timezone").notNull(),
    concurrencyMax: integer("concurrency_max").notNull(),
    concurrencyWaiting: integer("concurrency_waiting").notNull(),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    lastSkippedAt: timestamp("last_skipped_at", { withTimezone: true }),
    skippedCountSinceFire: integer("skipped_count_since_fire")
      .notNull()
      .default(0),
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("automation_schedules_automation_key_live_unique")
      .on(table.automationId, table.key)
      .where(sql`${table.removedAt} IS NULL`),
    index("automation_schedules_next_run_at_live_idx")
      .on(table.nextRunAt)
      .where(sql`${table.removedAt} IS NULL`),
  ],
);

/** A work-item automation attached to a work item. It follows the automation's latest version. */
export const workItemAutomations = appSchema.table(
  "work_item_automations",
  {
    workItemId: uuid("work_item_id")
      .references(() => workItems.id, { onDelete: "cascade" })
      .notNull(),
    automationId: uuid("automation_id")
      .references(() => automations.id, { onDelete: "cascade" })
      .notNull(),
    // References `identity.user.id` by value without a cross-schema FK, like
    // `work_items.created_by_user_id`.
    attachedByUserId: uuid("attached_by_user_id").notNull(),
    attachedAt: timestamp("attached_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workItemId, table.automationId] }),
    index("work_item_automations_automation_id_idx").on(table.automationId),
  ],
);

/**
 * A unit of work: the instructions and the outcome. Each attempt at it is a
 * TaskRun. A pipeline step visit creates one Task (`node_visits.task_id`).
 */
export const tasks = appSchema.table(
  "tasks",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    // Null for a chat Task, which has a conversation instead, and for a
    // scheduled Task, which its schedule owns.
    workItemId: uuid("work_item_id").references(() => workItems.id, {
      onDelete: "restrict",
    }),
    stepDefinitionId: uuid("step_definition_id").references(
      () => stepDefinitions.id,
      { onDelete: "restrict" },
    ),
    kind: taskKindEnum("kind").notNull(),
    name: text("name"),
    prompt: text("prompt"),
    entrypointJson: jsonb("entrypoint_json"),
    toolCallJson: jsonb("tool_call_json"),
    resultSchemaJson: jsonb("result_schema_json"),
    taskExecutionConfigId: uuid("task_execution_config_id").references(
      () => taskExecutionConfigs.id,
      { onDelete: "restrict" },
    ),
    inputJson: jsonb("input_json"),
    retryJson: jsonb("retry_json"),
    // The Task's extra connectors (`{ schemaVersion, extraConnectors }`);
    // null when it adds none. An environment override lives in the Task's
    // derived execution config instead.
    environmentSelectionJson: jsonb("environment_selection_json"),
    // What the Task's agent may do (`Grant[]`): its step definition's grants
    // when the Task started, plus `read` on `self`.
    grants: jsonb("grants_json").notNull().default([]),
    maxTurns: integer("max_turns"),
    // When set, the lease a claim or heartbeat grants is this long.
    heartbeatSeconds: integer("heartbeat_seconds"),
    executionTimeoutSeconds: integer("execution_timeout_seconds"),
    status: taskLifecycleStatusEnum("status").notNull(),
    resultJson: jsonb("result_json"),
    errorJson: jsonb("error_json"),
    // Version of the row's JSON columns; see `task-stored.ts`.
    schemaVersion: integer("schema_version").notNull(),
    // References identity.user.id by value.
    startedByUserId: uuid("started_by_user_id"),
    // The automation that started the Task (or its pipeline run); null once
    // the automation is deleted.
    startedByAutomationId: uuid("started_by_automation_id").references(
      () => automations.id,
      { onDelete: "set null" },
    ),
    previousTaskId: uuid("previous_task_id").references(
      (): AnyPgColumn => tasks.id,
      { onDelete: "restrict" },
    ),
    // The Task's conversation, once its agent first hands over.
    conversationId: uuid("conversation_id").references(
      (): AnyPgColumn => conversations.id,
      { onDelete: "set null" },
    ),
    // The schedule that started the Task and owns it; a scheduled Task has
    // no work item. Schedules are soft-deleted, so this never dangles.
    startedByScheduleId: uuid("started_by_schedule_id").references(
      () => automationSchedules.id,
      { onDelete: "no action" },
    ),
    // The cron time a scheduled Task runs for.
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    index("tasks_project_id_idx").on(table.projectId),
    uniqueIndex("tasks_started_by_schedule_id_scheduled_for_unique").on(
      table.startedByScheduleId,
      table.scheduledFor,
    ),
    index("tasks_started_by_schedule_id_status_scheduled_for_idx").on(
      table.startedByScheduleId,
      table.status,
      table.scheduledFor.desc(),
    ),
    uniqueIndex("tasks_conversation_id_unique").on(table.conversationId),
    index("tasks_work_item_id_idx").on(table.workItemId),
    index("tasks_status_idx").on(table.status),
    index("tasks_step_definition_id_idx").on(table.stepDefinitionId),
    index("tasks_task_execution_config_id_idx").on(table.taskExecutionConfigId),
    index("tasks_previous_task_id_idx").on(table.previousTaskId),
    index("tasks_started_by_automation_id_idx").on(table.startedByAutomationId),
    check(
      "tasks_kind_instructions_check",
      sql`(${table.kind} = 'agent' AND ${table.prompt} IS NOT NULL AND ${table.entrypointJson} IS NULL AND ${table.toolCallJson} IS NULL) OR (${table.kind} = 'code' AND ${table.entrypointJson} IS NOT NULL AND ${table.prompt} IS NULL AND ${table.toolCallJson} IS NULL) OR (${table.kind}::text = 'mcp_tool' AND ${table.toolCallJson} IS NOT NULL AND ${table.prompt} IS NULL AND ${table.entrypointJson} IS NULL)`,
    ),
    check(
      "tasks_owner_check",
      sql`${table.workItemId} IS NOT NULL OR ${table.conversationId} IS NOT NULL OR ${table.startedByScheduleId} IS NOT NULL`,
    ),
    check("tasks_schema_version_check", sql`${table.schemaVersion} >= 1`),
  ],
);

export const taskRuns = appSchema.table(
  "task_runs",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id")
      .references(() => tasks.id, { onDelete: "cascade" })
      .notNull(),
    // 1-based, in the order the Task's runs were started.
    number: integer("number").notNull(),
    reason: taskRunReasonEnum("reason").notNull(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    workItemId: uuid("work_item_id").references(() => workItems.id, {
      onDelete: "restrict",
    }),
    // Partial truth: this column can read `running` for a Task every API
    // reports as `abandoned`/`timeout`. Liveness (lease/deadline expiry) is
    // derived at read time by `TaskRunEntity`'s `status` getter and never
    // persisted. Any direct query must apply the clocks itself to get the
    // effective status. `yielded` is terminal: the agent handed the
    // conversation to a person, and the reply starts a new Task.
    status: taskStatusEnum("status").notNull(),
    // Set on completion and never changed afterwards.
    resultJson: jsonb("result_json"),
    errorJson: jsonb("error_json"),
    // Object-storage key of the agent session exported on yield.
    sessionObjectKey: text("session_object_key"),
    // Whether the worker restored the previous attempt's session; null when
    // there was nothing to restore.
    sessionRestored: boolean("session_restored"),
    // The branch to start from, set by whoever creates the Task.
    baseBranch: text("base_branch"),
    // The full commit object ID the run checks out, copied to later runs.
    baseCommit: text("base_commit"),
    // The named environment version the run uses, pinned when its worker
    // context is first built and copied to later runs.
    environmentVersionId: uuid("environment_version_id").references(
      () => environmentVersions.id,
      { onDelete: "set null" },
    ),
    // Reported by the worker on completion or yield.
    workBranch: text("work_branch"),
    createdFromBranch: text("created_from_branch"),
    claimedBy: text("claimed_by"),
    // References identity.user.id by value; the user whose credentials
    // claimed the run.
    claimedByUserId: uuid("claimed_by_user_id"),
    claimToken: text("claim_token"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    executionDeadlineAt: timestamp("execution_deadline_at", {
      withTimezone: true,
    }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Object-storage key of the finalized NDJSON log archive, once flushed. */
    logArchiveStoreRef: text("log_archive_store_ref"),
    logArchiveSizeBytes: bigint("log_archive_size_bytes", { mode: "number" }),
    /**
     * When the log archive was written to object storage. Set alongside
     * `log_archive_store_ref`/`log_archive_size_bytes` by `setLogArchive`. Lets
     * storage-usage reconciliation (billing/usage-meter) determine whether an
     * archive has aged past the S3 lifecycle expiration window WITHOUT calling
     * S3 — see `STORAGE_RETENTION_DAYS` / `isArchiveExpired`. Nullable: pre-existing
     * archive rows have no timestamp and are treated as present until cleared.
     */
    logArchivedAt: timestamp("log_archived_at", { withTimezone: true }),
    // Size of the exported agent session at `session_object_key`.
    sessionSizeBytes: bigint("session_size_bytes", { mode: "number" }),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    index("task_runs_project_id_idx").on(table.projectId),
    index("task_runs_status_idx").on(table.status),
    index("task_runs_log_archived_at_idx").on(table.logArchivedAt),
    index("task_runs_work_item_id_idx").on(table.workItemId),
    uniqueIndex("task_runs_task_id_number_unique").on(
      table.taskId,
      table.number,
    ),
  ],
);

/**
 * Object-storage prefixes of a deleted run still to be removed. `project_id`
 * and `task_run_id` are plain values with no foreign keys, so a sweep outlives
 * the run, Task, project or org it belonged to. `last_error` holds an error
 * code only, never transcript content.
 */
export const storageSweeps = appSchema.table(
  "storage_sweeps",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id").notNull(),
    taskRunId: uuid("task_run_id").notNull(),
    notBefore: timestamp("not_before", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: createdAtColumn(),
  },
  (table) => [index("storage_sweeps_not_before_idx").on(table.notBefore)],
);

/**
 * A message a user sent to a step, attached to the Task it started. A run's
 * messages are the messages on the Tasks of every run in its previous-run chain.
 */
export const taskMessages = appSchema.table(
  "task_messages",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id")
      .references(() => tasks.id, { onDelete: "cascade" })
      .notNull(),
    // References identity.user.id by value, like pipeline_runs.triggered_by_user_id.
    authorUserId: uuid("author_user_id").notNull(),
    body: text("body").notNull(),
    quoteText: text("quote_text"),
    createdAt: createdAtColumn(),
  },
  (table) => [index("task_messages_task_id_idx").on(table.taskId)],
);

/**
 * A conversation between an agent and people. Pipeline-unaware: a Task points
 * at its conversation through `tasks.conversation_id`.
 */
export const conversations = appSchema.table(
  "conversations",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    workItemId: uuid("work_item_id").references(() => workItems.id, {
      onDelete: "cascade",
    }),
    status: conversationStatusEnum("status").notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    index("conversations_project_id_idx").on(table.projectId),
    index("conversations_work_item_id_idx").on(table.workItemId),
  ],
);

export const conversationMessages = appSchema.table(
  "conversation_messages",
  {
    id: uuid("id").primaryKey(),
    conversationId: uuid("conversation_id")
      .references(() => conversations.id, { onDelete: "cascade" })
      .notNull(),
    authorKind: conversationMessageAuthorKindEnum("author_kind").notNull(),
    // References identity.user.id by value; null for agent messages.
    authorUserId: uuid("author_user_id"),
    // The attempt that wrote an agent message.
    taskRunId: uuid("task_run_id").references(() => taskRuns.id, {
      onDelete: "set null",
    }),
    // The attempt a person or system message was delivered into.
    deliveredToTaskRunId: uuid("delivered_to_task_run_id").references(
      () => taskRuns.id,
      {
        onDelete: "set null",
      },
    ),
    body: text("body").notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    index("conversation_messages_conversation_id_created_at_idx").on(
      table.conversationId,
      table.createdAt,
    ),
    index("conversation_messages_task_run_id_idx").on(table.taskRunId),
  ],
);

/**
 * One external agent session in one container, owned by one Task (D-11). A
 * conversation that outlives a container is a chain of rows sharing
 * `conversation_root_id`, which the root row sets to its own `id`.
 */
export const agentSessions = appSchema.table(
  "agent_sessions",
  {
    id: uuid("id").primaryKey(),
    taskRunId: uuid("task_run_id")
      .references((): AnyPgColumn => taskRuns.id, { onDelete: "cascade" })
      .notNull(),
    conversationRootId: uuid("conversation_root_id").references(
      (): AnyPgColumn => agentSessions.id,
      { onDelete: "set null" },
    ),
    parentAgentSessionId: uuid("parent_agent_session_id").references(
      (): AnyPgColumn => agentSessions.id,
      { onDelete: "set null" },
    ),
    provider: text("provider").notNull(),
    externalSessionId: text("external_session_id").notNull(),
    status: agentSessionStatusEnum("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    index("agent_sessions_task_run_id_idx").on(table.taskRunId),
    index("agent_sessions_conversation_root_id_idx").on(
      table.conversationRootId,
    ),
    index("agent_sessions_parent_agent_session_id_idx").on(
      table.parentAgentSessionId,
    ),
    uniqueIndex("agent_sessions_provider_external_session_id_unique").on(
      table.provider,
      table.externalSessionId,
    ),
  ],
);

/**
 * Live feed buffer for task logs (the "hot path"). Treated as a
 * transient ring buffer: rows are appended while a step runs, flushed to the
 * durable object-storage archive on completion, then purged. `seq` is the
 * monotonic per-step offset cursor used for incremental reads; the unique
 * (task_run_id, seq) index makes worker appends idempotent.
 */
export const taskLogLines = appSchema.table(
  "task_log_lines",
  {
    id: uuid("id").primaryKey(),
    taskRunId: uuid("task_run_id")
      .references(() => taskRuns.id, { onDelete: "cascade" })
      .notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    stream: taskLogStreamEnum("stream").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    content: text("content").notNull(),
    level: taskLogLevelEnum("level").notNull().default("info"),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex("task_log_lines_task_run_seq_unique").on(
      table.taskRunId,
      table.seq,
    ),
    index("task_log_lines_task_run_seq_idx").on(table.taskRunId, table.seq),
  ],
);

export const taskArtifacts = appSchema.table(
  "task_artifacts",
  {
    id: uuid("id").primaryKey(),
    taskRunId: uuid("task_run_id")
      .references(() => taskRuns.id, { onDelete: "cascade" })
      .notNull(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    relativeStorePath: text("relative_store_path").notNull(),
    /**
     * Object-storage key (the S3 key) the artifact was uploaded under.
     * Nullable: nulled out once the artifact ages past `STORAGE_RETENTION_DAYS`
     * (see `clearExpiredArtifacts`), mirroring the S3 lifecycle rule that
     * expires the underlying object under the same window.
     */
    objectKey: text("object_key"),
    /**
     * Fully-qualified store reference, e.g. `s3://bucket/key`. Nullable for the
     * same reason as `objectKey` above — cleared once the artifact expires.
     */
    storeRef: text("store_ref"),
    /**
     * Nullable for the same reason as `objectKey`/`storeRef` above — cleared
     * once the artifact expires.
     */
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    contentType: text("content_type"),
    kind: text("kind").notNull().default("generic"),
    /**
     * Set once at insert and never updated. Serves directly as the aging
     * anchor for expiry (see `STORAGE_RETENTION_DAYS` / `clearExpiredArtifacts`)
     * — unlike `taskRuns.logArchivedAt`, artifacts need no separate
     * "archived at" column since they are never rewritten after creation.
     */
    createdAt: createdAtColumn(),
    /**
     * Soft-delete marker: set when an artifact is deleted by a user, null
     * while the artifact is still active. Mirrors the nullable-timestamp
     * style of `pipelineGraphs.archivedAt` and `taskRuns.logArchivedAt`.
     */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("task_artifacts_task_run_id_idx").on(table.taskRunId),
    index("task_artifacts_created_at_idx").on(table.createdAt),
    index("task_artifacts_project_id_idx").on(table.projectId),
    index("task_artifacts_project_deleted_idx").on(
      table.projectId,
      table.deletedAt,
    ),
  ],
);

/**
 * Failed artifact-upload attempts — a SEPARATE concept from
 * `taskArtifacts` above, not a status column on that table.
 * `taskArtifacts` means "successfully stored, full stop" throughout
 * the codebase (retention nulling, usage-metering events, download-URL
 * minting all assume success); a failed upload never produced a row there.
 * This table is purely informational — it is never read by policy
 * evaluation. Failure rows carry no bytes, so expiry hard-deletes them
 * outright (see `deleteExpiredFailures`) rather than nulling columns like
 * `clearExpiredArtifacts` does above.
 */
export const taskArtifactFailures = appSchema.table(
  "task_artifact_failures",
  {
    id: uuid("id").primaryKey(),
    taskRunId: uuid("task_run_id")
      .references(() => taskRuns.id, { onDelete: "cascade" })
      .notNull(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    relativeStorePath: text("relative_store_path").notNull(),
    attemptedSizeBytes: bigint("attempted_size_bytes", {
      mode: "number",
    }).notNull(),
    kind: text("kind").notNull().default("generic"),
    errorCode: text("error_code").notNull(),
    errorMessage: text("error_message").notNull(),
    httpStatus: integer("http_status"),
    /**
     * Sole aging anchor for expiry — mirrors `taskArtifacts.createdAt`
     * above. Reuses the same `STORAGE_RETENTION_DAYS` window.
     */
    createdAt: createdAtColumn(),
  },
  (table) => [
    index("task_artifact_failures_task_run_created_idx").on(
      table.taskRunId,
      table.createdAt.desc(),
    ),
  ],
);

/**
 * The outcome of resolving each artifact field (`x-scarn-artifact` in the
 * result schema) of a Task's result, written when the Task completes.
 * `artifact_id` is null when the artifact was unavailable; the reason is one
 * of `not_reported | wrong_extension | not_found | upload_failed:<detail>`.
 */
export const taskArtifactResolutions = appSchema.table(
  "task_artifact_resolutions",
  {
    taskRunId: uuid("task_run_id")
      .references(() => taskRuns.id, { onDelete: "cascade" })
      .notNull(),
    resultPath: text("result_path").notNull(),
    artifactId: uuid("artifact_id").references(() => taskArtifacts.id, {
      onDelete: "set null",
    }),
    unavailableReason: text("unavailable_reason"),
    createdAt: createdAtColumn(),
  },
  (table) => [
    primaryKey({ columns: [table.taskRunId, table.resultPath] }),
    index("task_artifact_resolutions_artifact_id_idx").on(table.artifactId),
  ],
);

export const userNotifications = appSchema.table(
  "user_notifications",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    workItemId: uuid("work_item_id").references(() => workItems.id, {
      onDelete: "set null",
    }),
    pipelineExecutionId: uuid("pipeline_execution_id").references(
      () => pipelineRuns.id,
      { onDelete: "set null" },
    ),
    taskId: uuid("task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    agentSessionId: uuid("agent_session_id").references(
      () => agentSessions.id,
      { onDelete: "set null" },
    ),
    // References identity.user.id by value; null for a notification to the
    // whole project rather than one person.
    recipientUserId: uuid("recipient_user_id"),
    kind: userNotificationKindEnum("kind").notNull(),
    audience: notificationAudienceEnum("audience").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    priority: notificationPriorityEnum("priority").notNull().default("normal"),
    source: notificationSourceEnum("source").notNull(),
    status: userNotificationStatusEnum("status").notNull().default("pending"),
    // Kind-specific structured data (e.g. feedback_request: category/urgency).
    payloadJson: jsonb("payload_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("user_notifications_project_id_idx").on(table.projectId),
    index("user_notifications_work_item_id_idx").on(table.workItemId),
    index("user_notifications_project_status_idx").on(
      table.projectId,
      table.status,
    ),
    index("user_notifications_project_recipient_idx").on(
      table.projectId,
      table.recipientUserId,
    ),
  ],
);

export const notificationDeliveries = appSchema.table(
  "notification_deliveries",
  {
    id: uuid("id").primaryKey(),
    notificationId: uuid("notification_id")
      .references(() => userNotifications.id, { onDelete: "cascade" })
      .notNull(),
    channel: notificationChannelEnum("channel").notNull(),
    status: notificationDeliveryStatusEnum("status")
      .notNull()
      .default("pending"),
    suppressionReason: text("suppression_reason"),
    externalUrl: text("external_url"),
    externalId: text("external_id"),
    /**
     * `work_item_platform_comment` only: the per-marker artifact resolution
     * of the draft body, then the per-marker outcomes once approved. Null
     * when the body has no artifact markers.
     */
    artifactResolutionJson: jsonb("artifact_resolution_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => [
    index("notification_deliveries_notification_id_idx").on(
      table.notificationId,
    ),
    uniqueIndex("notification_deliveries_notification_channel_unique").on(
      table.notificationId,
      table.channel,
    ),
  ],
);

export const notificationRules = appSchema.table(
  "notification_rules",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    kind: userNotificationKindEnum("kind").notNull(),
    channel: notificationChannelEnum("channel").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    minPriority: notificationPriorityEnum("min_priority"),
    // Reserved for quiet-hours / rate-limits etc.
    conditionsJson: jsonb("conditions_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("notification_rules_project_id_idx").on(table.projectId),
    uniqueIndex("notification_rules_project_kind_channel_unique").on(
      table.projectId,
      table.kind,
      table.channel,
    ),
  ],
);

// --- Pipeline runs. A run records visits (the run entered node X, on lane
// L, from visit V); status columns hold only the engine's decisions, and
// whether a step is queued or running is read from its Task.

export const pipelineRuns = appSchema.table(
  "pipeline_runs",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    workItemId: uuid("work_item_id")
      .references(() => workItems.id, { onDelete: "restrict" })
      .notNull(),
    pipelineGraphId: uuid("pipeline_graph_id")
      .references(() => pipelineGraphs.id, { onDelete: "restrict" })
      .notNull(),
    pipelineGraphVersionId: uuid("pipeline_graph_version_id")
      .references(() => pipelineGraphVersions.id, { onDelete: "restrict" })
      .notNull(),
    status: pipelineRunStatusEnum("status").notNull(),
    // The succeed/fail node the run ended at.
    endNodeId: text("end_node_id"),
    errorJson: jsonb("error_json"),
    // The user who started the run; null for runs a system path created
    // (an automation). References
    // `identity.user.id` by uuid value WITHOUT a cross-schema FK, matching
    // `projects.created_by_user_id`.
    triggeredByUserId: uuid("triggered_by_user_id"),
    // The automation that started the run; null once it is deleted.
    startedByAutomationId: uuid("started_by_automation_id").references(
      () => automations.id,
      { onDelete: "set null" },
    ),
    cancelledByUserId: uuid("cancelled_by_user_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    index("pipeline_runs_project_id_idx").on(table.projectId),
    index("pipeline_runs_project_created_at_idx").on(
      table.projectId,
      table.createdAt.desc(),
    ),
    index("pipeline_runs_pipeline_graph_id_idx").on(table.pipelineGraphId),
    index("pipeline_runs_pipeline_graph_version_id_idx").on(
      table.pipelineGraphVersionId,
    ),
    index("pipeline_runs_work_item_id_idx").on(table.workItemId),
    index("pipeline_runs_started_by_automation_id_idx").on(
      table.startedByAutomationId,
    ),
  ],
);

/** One split taken (an `each` route or a `match: "all"` node): the lanes it spawned share this group. */
export const laneGroups = appSchema.table(
  "lane_groups",
  {
    id: uuid("id").primaryKey(),
    pipelineRunId: uuid("pipeline_run_id")
      .references(() => pipelineRuns.id, { onDelete: "cascade" })
      .notNull(),
    parentLaneId: uuid("parent_lane_id").references(
      (): AnyPgColumn => lanes.id,
      { onDelete: "cascade" },
    ),
    spawnedByVisitId: uuid("spawned_by_visit_id")
      .references((): AnyPgColumn => nodeVisits.id, { onDelete: "cascade" })
      .notNull(),
    kind: laneGroupKindEnum("kind").notNull(),
    laneCount: integer("lane_count").notNull(),
    maxConcurrency: integer("max_concurrency"),
    // `{ count }` or `{ percent }`: exactly one of the two is set.
    toleratedFailuresCount: integer("tolerated_failures_count"),
    toleratedFailuresPercent: doublePrecision("tolerated_failures_percent"),
    status: laneGroupStatusEnum("status").notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    index("lane_groups_pipeline_run_id_idx").on(table.pipelineRunId),
    index("lane_groups_spawned_by_visit_id_idx").on(table.spawnedByVisitId),
    index("lane_groups_parent_lane_id_idx").on(table.parentLaneId),
    check(
      "lane_groups_tolerated_failures_check",
      sql`num_nonnulls(${table.toleratedFailuresCount}, ${table.toleratedFailuresPercent}) = 1`,
    ),
  ],
);

export const lanes = appSchema.table(
  "lanes",
  {
    id: uuid("id").primaryKey(),
    laneGroupId: uuid("lane_group_id")
      .references((): AnyPgColumn => laneGroups.id, { onDelete: "cascade" })
      .notNull(),
    index: integer("index").notNull(),
    itemJson: jsonb("item_json"),
    routeJson: jsonb("route").notNull(),
    origin: laneOriginEnum("origin").notNull(),
    status: laneStatusEnum("status").notNull(),
    // The lane's live arrival at a merge (a `partial` route); a rerun clears it.
    arrivedAtNodeId: text("arrived_at_node_id"),
    arrivalArgsJson: jsonb("arrival_args_json"),
    arrivedFromVisitId: uuid("arrived_from_visit_id").references(
      (): AnyPgColumn => nodeVisits.id,
      { onDelete: "set null" },
    ),
    arrivalTransitionJson: jsonb("arrival_transition"),
    mergedIntoVisitId: uuid("merged_into_visit_id").references(
      (): AnyPgColumn => nodeVisits.id,
      { onDelete: "set null" },
    ),
    schemaVersion: integer("schema_version").notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex("lanes_group_index_unique").on(table.laneGroupId, table.index),
    check("lanes_schema_version_check", sql`${table.schemaVersion} >= 1`),
  ],
);

/**
 * "The run entered node X, on lane L, from visit V". Written once: a rerun
 * marks the visit `superseded` and creates a new one rather than editing it.
 */
export const nodeVisits = appSchema.table(
  "node_visits",
  {
    id: uuid("id").primaryKey(),
    pipelineRunId: uuid("pipeline_run_id")
      .references(() => pipelineRuns.id, { onDelete: "cascade" })
      .notNull(),
    nodeId: text("node_id").notNull(),
    nodeKind: nodeVisitKindEnum("node_kind").notNull(),
    laneId: uuid("lane_id").references((): AnyPgColumn => lanes.id, {
      onDelete: "cascade",
    }),
    fromVisitId: uuid("from_visit_id").references(
      (): AnyPgColumn => nodeVisits.id,
      { onDelete: "cascade" },
    ),
    fromLaneGroupId: uuid("from_lane_group_id").references(
      (): AnyPgColumn => laneGroups.id,
      { onDelete: "cascade" },
    ),
    transitionJson: jsonb("transition").notNull(),
    routingJson: jsonb("routing_json"),
    status: nodeVisitStatusEnum("status").notNull(),
    inputJson: jsonb("input_json").notNull(),
    // The step visit's Task, set when the visit queues its first run.
    taskId: uuid("task_id").references(() => tasks.id, {
      onDelete: "restrict",
    }),
    resultJson: jsonb("result_json"),
    errorJson: jsonb("error_json"),
    createdByUserId: uuid("created_by_user_id"),
    resolvedByUserId: uuid("resolved_by_user_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    schemaVersion: integer("schema_version").notNull(),
  },
  (table) => [
    check("node_visits_schema_version_check", sql`${table.schemaVersion} >= 1`),
    index("node_visits_pipeline_run_id_idx").on(table.pipelineRunId),
    index("node_visits_pipeline_run_node_id_idx").on(
      table.pipelineRunId,
      table.nodeId,
    ),
    uniqueIndex("node_visits_task_id_unique").on(table.taskId),
  ],
);

/**
 * A question comment a visit is waiting on. The comment is written first;
 * a comment is a question when a row here points at it.
 */
export const nodeVisitQuestions = appSchema.table(
  "node_visit_questions",
  {
    id: uuid("id").primaryKey(),
    pipelineRunId: uuid("pipeline_run_id")
      .references(() => pipelineRuns.id, { onDelete: "cascade" })
      .notNull(),
    visitId: uuid("visit_id")
      .references(() => nodeVisits.id, { onDelete: "cascade" })
      .notNull(),
    commentId: uuid("comment_id")
      .references(() => workItemComments.id, { onDelete: "cascade" })
      .notNull(),
    status: nodeVisitQuestionStatusEnum("status").notNull(),
    answerCommentId: uuid("answer_comment_id").references(
      () => workItemComments.id,
      { onDelete: "set null" },
    ),
    answeredByUserId: uuid("answered_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("node_visit_questions_comment_id_unique").on(table.commentId),
    index("node_visit_questions_visit_id_idx").on(table.visitId),
    index("node_visit_questions_pipeline_run_id_idx").on(table.pipelineRunId),
  ],
);

export const githubInstallations = appSchema.table(
  "github_installations",
  {
    id: uuid("id").primaryKey(),
    installationId: text("installation_id").notNull(),
    accountLogin: text("account_login"),
    accountType: text("account_type"),
    targetType: text("target_type"),
    selectedRepositoriesJson: jsonb("selected_repositories_json"),
    installedByUserId: uuid("installed_by_user_id"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("github_installations_installation_id_unique").on(
      table.installationId,
    ),
    index("github_installations_installed_by_user_id_idx").on(
      table.installedByUserId,
    ),
  ],
);

export const projectIntegrationStatusEnum = pgEnum(
  "project_integration_status",
  ["active", "paused", "error"],
);

export const projectIntegrationKindEnum = pgEnum("project_integration_kind", [
  "github_app",
  "github_token",
  "bitbucket",
  "jira",
]);

export const projectIntegrations = appSchema.table(
  "project_integrations",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    kind: projectIntegrationKindEnum("kind").notNull(),
    installationId: text("installation_id"),
    externalScopeJson: jsonb("external_scope_json").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    status: projectIntegrationStatusEnum("status").notNull().default("active"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastError: text("last_error"),
    firstSyncHorizonDays: integer("first_sync_horizon_days"),
    syncSecretId: uuid("sync_secret_id").references(() => secrets.id, {
      onDelete: "set null",
    }),
    syncLockedUntil: timestamp("sync_locked_until", { withTimezone: true }),
    autoSyncPausedReason: text("auto_sync_paused_reason"),
    autoSyncPausedAt: timestamp("auto_sync_paused_at", { withTimezone: true }),
    autoSyncPausedDetail: text("auto_sync_paused_detail"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("project_integrations_project_github_app_install_unique")
      .on(table.projectId, table.installationId)
      .where(sql`${table.kind} = 'github_app'`),
    index("project_integrations_project_id_idx").on(table.projectId),
    index("project_integrations_installation_id_idx").on(table.installationId),
    index("project_integrations_sync_secret_id_idx").on(table.syncSecretId),
    check(
      "project_integrations_schema_version_check",
      sql`${table.schemaVersion} >= 1`,
    ),
    check(
      "project_integrations_kind_installation_check",
      sql`(${table.kind} = 'github_app') = (${table.installationId} IS NOT NULL)`,
    ),
    check(
      "project_integrations_sync_secret_kind_check",
      sql`${table.syncSecretId} IS NULL OR ${table.kind} IN ('jira', 'github_token')`,
    ),
    check(
      "project_integrations_auto_sync_paused_reason_check",
      sql`${table.autoSyncPausedReason} IS NULL OR ${table.autoSyncPausedReason} IN ('key_removed', 'key_rejected', 'key_expired', 'owner_left_project', 'access_lost')`,
    ),
  ],
);

export const projectInvites = appSchema.table(
  "project_invites",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    email: text("email"),
    role: text("role").notNull(),
    restriction: text("restriction").notNull(),
    tokenHash: text("token_hash").notNull(),
    invitedByUserId: uuid("invited_by_user_id").notNull(),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedByUserId: uuid("accepted_by_user_id"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    index("project_invites_project_id_idx").on(table.projectId),
    index("project_invites_project_email_status_idx").on(
      table.projectId,
      table.email,
      table.status,
    ),
    index("project_invites_project_restriction_status_idx").on(
      table.projectId,
      table.restriction,
      table.status,
    ),
    uniqueIndex("project_invites_token_hash_unique").on(table.tokenHash),
  ],
);

export const usageMeters = appSchema.table(
  "usage_meters",
  {
    // Owning organization (tenancy/billing boundary). References
    // `identity.organization.id` by uuid value WITHOUT a cross-schema FK, the
    // same convention used for `project_memberships.user_id`.
    orgId: uuid("org_id").notNull(),
    // Calendar billing period, "YYYY-MM".
    period: text("period").notNull(),
    planId: text("plan_id").notNull(),
    writes: bigint("writes", { mode: "number" }).notNull().default(0),
    reads: bigint("reads", { mode: "number" }).notNull().default(0),
    // Byte counter mirrors `task_runs.log_archive_size_bytes`:
    // bigint with `mode: "number"`, so it surfaces as a JS number.
    storageBytes: bigint("storage_bytes", { mode: "number" })
      .notNull()
      .default(0),
    signalTokens: bigint("signal_tokens", { mode: "number" })
      .notNull()
      .default(0),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("usage_meters_org_period_unique").on(table.orgId, table.period),
    index("usage_meters_org_id_idx").on(table.orgId),
  ],
);

export const secretKindEnum = pgEnum("secret_kind", [
  "jira_api_key",
  "github_token",
  "bitbucket_api_token",
  "project_secret",
]);

export const secretValueKindEnum = pgEnum("secret_value_kind", ["static"]);

// A secret is owned by exactly one of a user or a project. `owner_user_id`
// references `identity.user.id` by value without a cross-schema FK, like
// `project_memberships.user_id`; `owner_project_id` cascades with its project.
// `updated_by_user_id` (who last created, renamed or replaced it) references
// `identity.user.id` by value the same way.
// `metadata_json` is per-kind, non-secret metadata; the secret material lives
// only in the encrypted `ciphertext`/`iv`/`auth_tag` columns.
export const secrets = appSchema.table(
  "secrets",
  {
    id: uuid("id").primaryKey(),
    ownerUserId: uuid("owner_user_id"),
    ownerProjectId: uuid("owner_project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    kind: secretKindEnum("kind").notNull(),
    valueKind: secretValueKindEnum("value_kind").notNull().default("static"),
    name: text("name").notNull(),
    metadataJson: jsonb("metadata_json").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    iv: bytea("iv").notNull(),
    authTag: bytea("auth_tag").notNull(),
    keyVersion: integer("key_version").notNull(),
    lastFour: text("last_four").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    updatedByUserId: uuid("updated_by_user_id"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    index("secrets_owner_user_id_idx").on(table.ownerUserId),
    uniqueIndex("secrets_owner_user_kind_name_unique").on(
      table.ownerUserId,
      table.kind,
      table.name,
    ),
    uniqueIndex("secrets_owner_project_name_unique").on(
      table.ownerProjectId,
      table.name,
    ),
    check(
      "secrets_exactly_one_owner_check",
      sql`num_nonnulls(${table.ownerUserId}, ${table.ownerProjectId}) = 1`,
    ),
    check("secrets_schema_version_check", sql`${table.schemaVersion} >= 1`),
  ],
);

export const managedConnectionStateEnum = pgEnum("managed_connection_state", [
  "disconnected",
  "connecting",
  "awaiting_confirmation",
  "ready",
  "ready_with_pending_reconnect",
  "reconnect_required",
]);

export const managedOAuthAttemptKindEnum = pgEnum(
  "managed_oauth_attempt_kind",
  ["connect", "reconnect"],
);

export const managedOAuthAttemptStatusEnum = pgEnum(
  "managed_oauth_attempt_status",
  ["pending", "exchanging", "succeeded", "failed", "expired", "cancelled"],
);

export const managedConnectionEventTypeEnum = pgEnum(
  "managed_connection_event_type",
  [
    "connect_started",
    "reconnect_started",
    "attempt_failed",
    "candidate_attached",
    "candidate_confirmed",
    "candidate_cancelled",
    "candidate_expired",
    "reconnect_required",
    "disconnected",
    "revocation_attempted",
    "refresh_succeeded",
    "refresh_failed",
    "refresh_claim_recovered",
    "launch_registered",
    "authority_lost",
  ],
);

export const managedLaunchConnectionStateEnum = pgEnum(
  "managed_launch_connection_state",
  ["open", "closed"],
);

export const managedRevocationOutcomeEnum = pgEnum(
  "managed_revocation_outcome",
  ["accepted", "failed", "unconfirmed"],
);

// A project's link to a hosted MCP server (ADR 0013). The row owns its server
// (`resource`, `issuer_origin`, `client_registration`, and for a `supplied`
// client exactly its `supplied_client_id` and `supplied_redirect_uri`, plus
// the `discovery` overrides it needs, `{}` for none); `preset` only records
// which catalog entry filled it in. One per name and one per MCP URL per
// project. `version` is the compare-and-set counter every transition bumps;
// `generation` only moves when the grant it serves changes. The row outlives
// a disconnect as a tombstone so its UUID never rebinds to another account.
// `connected_by_user_id` references `identity.user.id` by value, like
// `secrets.updated_by_user_id`.
export const managedMcpConnections = appSchema.table(
  "managed_mcp_connections",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    label: text("label").notNull(),
    resource: text("resource").notNull(),
    issuerOrigin: text("issuer_origin").notNull(),
    clientRegistration: text("client_registration").notNull(),
    suppliedClientId: text("supplied_client_id"),
    suppliedRedirectUri: text("supplied_redirect_uri"),
    discovery: jsonb("discovery").notNull().default({}),
    scopes: text("scopes").array(),
    preset: text("preset"),
    state: managedConnectionStateEnum("state").notNull(),
    reasonCode: text("reason_code"),
    generation: integer("generation").notNull().default(0),
    version: integer("version").notNull().default(0),
    activeGrantId: uuid("active_grant_id").references(
      (): AnyPgColumn => managedOAuthGrants.id,
    ),
    candidateGrantId: uuid("candidate_grant_id").references(
      (): AnyPgColumn => managedOAuthGrants.id,
    ),
    connectedByUserId: uuid("connected_by_user_id"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("managed_mcp_connections_project_name_unique").on(
      table.projectId,
      table.name,
    ),
    uniqueIndex("managed_mcp_connections_project_resource_unique").on(
      table.projectId,
      table.resource,
    ),
    check(
      "managed_mcp_connections_state_shape_check",
      sql`(${table.state} = 'disconnected' and ${table.activeGrantId} is null and ${table.candidateGrantId} is null and ${table.connectedByUserId} is null)
        or (${table.state} = 'connecting' and ${table.activeGrantId} is null and ${table.candidateGrantId} is null and ${table.connectedByUserId} is null and ${table.reasonCode} is null)
        or (${table.state} = 'awaiting_confirmation' and ${table.activeGrantId} is null and ${table.candidateGrantId} is not null and ${table.connectedByUserId} is null and ${table.reasonCode} is null)
        or (${table.state} = 'ready' and ${table.activeGrantId} is not null and ${table.candidateGrantId} is null and ${table.connectedByUserId} is not null and ${table.reasonCode} is null)
        or (${table.state} = 'ready_with_pending_reconnect' and ${table.activeGrantId} is not null and ${table.candidateGrantId} is not null and ${table.connectedByUserId} is not null and ${table.reasonCode} is null)
        or (${table.state} = 'reconnect_required' and ${table.activeGrantId} is not null and ${table.connectedByUserId} is not null and ${table.reasonCode} is not null)`,
    ),
    check(
      "managed_mcp_connections_counters_check",
      sql`${table.generation} >= 0 and ${table.version} >= 0`,
    ),
    check(
      "managed_mcp_connections_supplied_client_check",
      sql`(${table.clientRegistration} = 'supplied' and ${table.suppliedClientId} is not null and ${table.suppliedRedirectUri} is not null)
        or (${table.clientRegistration} <> 'supplied' and ${table.suppliedClientId} is null and ${table.suppliedRedirectUri} is null)`,
    ),
  ],
);

// The tokens and identity a provider issued to a managed connection. Both are
// encrypted with `SecretCipher` under their own AAD (`managed-grant-aad.ts`).
// The credential columns are cleared when the grant is retired; the identity
// stays until the row is swept 30 days later. `client_id` is copied from
// config so a later change can be detected.
export const managedOAuthGrants = appSchema.table(
  "managed_oauth_grants",
  {
    id: uuid("id").primaryKey(),
    connectionId: uuid("connection_id")
      .references((): AnyPgColumn => managedMcpConnections.id, {
        onDelete: "cascade",
      })
      .notNull(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    clientId: text("client_id").notNull(),
    issuer: text("issuer").notNull(),
    resource: text("resource").notNull(),
    credentialVersion: integer("credential_version").notNull().default(1),
    credentialsCiphertext: bytea("credentials_ciphertext"),
    credentialsIv: bytea("credentials_iv"),
    credentialsAuthTag: bytea("credentials_auth_tag"),
    credentialsKeyVersion: integer("credentials_key_version"),
    identityCiphertext: bytea("identity_ciphertext").notNull(),
    identityIv: bytea("identity_iv").notNull(),
    identityAuthTag: bytea("identity_auth_tag").notNull(),
    identityKeyVersion: integer("identity_key_version").notNull(),
    grantedScopes: text("granted_scopes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }).notNull(),
    reconnectBy: timestamp("reconnect_by", { withTimezone: true }).notNull(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    refreshClaimId: uuid("refresh_claim_id"),
    refreshClaimedAt: timestamp("refresh_claimed_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    index("managed_oauth_grants_connection_id_idx").on(table.connectionId),
    check(
      "managed_oauth_grants_refresh_claim_shape_check",
      sql`num_nonnulls(${table.refreshClaimId}, ${table.refreshClaimedAt}) in (0, 2)
        and (${table.retiredAt} is null or ${table.refreshClaimId} is null)`,
    ),
    index("managed_oauth_grants_retired_at_idx").on(table.retiredAt),
    check(
      "managed_oauth_grants_credentials_shape_check",
      sql`(${table.retiredAt} is null and num_nonnulls(${table.credentialsCiphertext}, ${table.credentialsIv}, ${table.credentialsAuthTag}, ${table.credentialsKeyVersion}) = 4)
        or (${table.retiredAt} is not null and num_nonnulls(${table.credentialsCiphertext}, ${table.credentialsIv}, ${table.credentialsAuthTag}, ${table.credentialsKeyVersion}) = 0)`,
    ),
  ],
);

// The OAuth clients Scarn registered by dynamic client registration (RFC
// 7591), one live client per authorization server and redirect URI. Keyed by
// issuer, not connection or preset, so every connection to one authorization
// server shares it. `stale_at` is set when the server stops recognising the
// client (`invalid_client`); the next connect registers a new one. Public
// clients only: no secret is ever stored.
export const managedOAuthClients = appSchema.table(
  "managed_oauth_clients",
  {
    id: uuid("id").primaryKey(),
    issuer: text("issuer").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    clientId: text("client_id").notNull(),
    registeredAt: timestamp("registered_at", { withTimezone: true }).notNull(),
    staleAt: timestamp("stale_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("managed_oauth_clients_issuer_redirect_uri_live_unique")
      .on(table.issuer, table.redirectUri)
      .where(sql`${table.staleAt} IS NULL`),
  ],
);

// One trip through the provider's OAuth consent. `completion` says who
// finishes it: a `server_callback` attempt is bound to the browser session
// that started it, a `loopback` attempt to a secret held by the CLI. Only
// digests of `state` and of that binding are stored. The PKCE verifier is
// encrypted and cleared once the attempt leaves `pending`/`exchanging`.
// `actor_user_id` references `identity.user.id` by value.
export const managedOAuthAttempts = appSchema.table(
  "managed_oauth_attempts",
  {
    id: uuid("id").primaryKey(),
    connectionId: uuid("connection_id")
      .references(() => managedMcpConnections.id, { onDelete: "cascade" })
      .notNull(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    kind: managedOAuthAttemptKindEnum("kind").notNull(),
    expectedGeneration: integer("expected_generation").notNull(),
    actorUserId: uuid("actor_user_id").notNull(),
    completion: text("completion").notNull().default("server_callback"),
    browserSessionDigest: text("browser_session_digest"),
    completionSecretDigest: text("completion_secret_digest"),
    stateDigest: text("state_digest").notNull(),
    pkceVerifierCiphertext: bytea("pkce_verifier_ciphertext"),
    pkceVerifierIv: bytea("pkce_verifier_iv"),
    pkceVerifierAuthTag: bytea("pkce_verifier_auth_tag"),
    pkceVerifierKeyVersion: integer("pkce_verifier_key_version"),
    clientId: text("client_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    requestedScopes: text("requested_scopes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: managedOAuthAttemptStatusEnum("status").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    candidateGrantId: uuid("candidate_grant_id").references(
      () => managedOAuthGrants.id,
      { onDelete: "set null" },
    ),
    failureCode: text("failure_code"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("managed_oauth_attempts_state_digest_unique").on(
      table.stateDigest,
    ),
    index("managed_oauth_attempts_connection_id_idx").on(table.connectionId),
    index("managed_oauth_attempts_expires_at_idx").on(table.expiresAt),
    check(
      "managed_oauth_attempts_verifier_shape_check",
      sql`(${table.status} in ('pending', 'exchanging') and num_nonnulls(${table.pkceVerifierCiphertext}, ${table.pkceVerifierIv}, ${table.pkceVerifierAuthTag}, ${table.pkceVerifierKeyVersion}) = 4)
        or (${table.status} not in ('pending', 'exchanging') and num_nonnulls(${table.pkceVerifierCiphertext}, ${table.pkceVerifierIv}, ${table.pkceVerifierAuthTag}, ${table.pkceVerifierKeyVersion}) = 0)`,
    ),
    check(
      "managed_oauth_attempts_failure_code_check",
      sql`(${table.status} = 'failed') = (${table.failureCode} is not null)`,
    ),
    check(
      "managed_oauth_attempts_completion_check",
      sql`(${table.completion} = 'server_callback' and ${table.browserSessionDigest} is not null and ${table.completionSecretDigest} is null)
        or (${table.completion} = 'loopback' and ${table.browserSessionDigest} is null and ${table.completionSecretDigest} is not null)`,
    ),
  ],
);

// One connection a managed launch may use (ADR 0013, Relay). Pins the
// connection's generation and serving grant at registration; `grant_id` is a
// value, not a foreign key, so a retired or swept grant leaves the pin behind
// to fail the authority check. Only digests of the relay capability, the
// claim token and the provider's MCP session ID are stored.
export const managedMcpLaunchConnections = appSchema.table(
  "managed_mcp_launch_connections",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    taskRunId: uuid("task_run_id")
      .references(() => taskRuns.id, { onDelete: "cascade" })
      .notNull(),
    claimTokenDigest: bytea("claim_token_digest").notNull(),
    entryKey: text("entry_key").notNull(),
    connectionId: uuid("connection_id")
      .references(() => managedMcpConnections.id, { onDelete: "cascade" })
      .notNull(),
    generation: integer("generation").notNull(),
    grantId: uuid("grant_id").notNull(),
    capabilityDigest: bytea("capability_digest").notNull(),
    mcpSessionIdDigest: bytea("mcp_session_id_digest"),
    state: managedLaunchConnectionStateEnum("state").notNull(),
    createdAt: createdAtColumn(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("managed_mcp_launch_connections_capability_digest_unique").on(
      table.capabilityDigest,
    ),
    uniqueIndex("managed_mcp_launch_connections_run_claim_entry_unique").on(
      table.taskRunId,
      table.claimTokenDigest,
      table.entryKey,
    ),
    index("managed_mcp_launch_connections_task_run_state_idx").on(
      table.taskRunId,
      table.state,
    ),
    index("managed_mcp_launch_connections_connection_id_idx").on(
      table.connectionId,
    ),
    check(
      "managed_mcp_launch_connections_closed_shape_check",
      sql`(${table.state} = 'closed') = (${table.closedAt} is not null)`,
    ),
    check(
      "managed_mcp_launch_connections_generation_check",
      sql`${table.generation} >= 0`,
    ),
  ],
);

// One relayed call, leased until `deadline_at` (ADR 0013, Relay). Deleted
// when the call ends; a row still present past its deadline is an unknown
// operation the authority fence fails the run for.
export const managedMcpOperations = appSchema.table(
  "managed_mcp_operations",
  {
    id: uuid("id").primaryKey(),
    launchConnectionId: uuid("launch_connection_id")
      .references(() => managedMcpLaunchConnections.id, {
        onDelete: "cascade",
      })
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("managed_mcp_operations_launch_connection_id_idx").on(
      table.launchConnectionId,
    ),
    check(
      "managed_mcp_operations_deadline_check",
      sql`${table.deadlineAt} > ${table.startedAt}`,
    ),
  ],
);

// Audit trail for managed connections, kept 30 days. Never holds credentials,
// identity values, relay capabilities or MCP session IDs. `actor_user_id`
// references `identity.user.id` by value and is nullable so the actor can be
// unlinked. `task_run_id` names the run on launch events, by value so the
// trail outlives the run.
export const managedConnectionEvents = appSchema.table(
  "managed_connection_events",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    connectionId: uuid("connection_id")
      .references(() => managedMcpConnections.id, { onDelete: "cascade" })
      .notNull(),
    actorUserId: uuid("actor_user_id"),
    taskRunId: uuid("task_run_id"),
    type: managedConnectionEventTypeEnum("type").notNull(),
    generation: integer("generation").notNull(),
    reasonCode: text("reason_code"),
    revocationOutcome: managedRevocationOutcomeEnum("revocation_outcome"),
    sameIdentityAsActive: boolean("same_identity_as_active"),
    createdAt: createdAtColumn(),
  },
  (table) => [
    index("managed_connection_events_connection_id_idx").on(table.connectionId),
    index("managed_connection_events_created_at_idx").on(table.createdAt),
  ],
);

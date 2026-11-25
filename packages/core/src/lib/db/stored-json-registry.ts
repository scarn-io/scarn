/**
 * Every table with `jsonb` columns and how those columns are read. See
 * `docs/persistence/json-columns.md` and `docs/plans/json-column-versioning.md`.
 *
 * - `versioned`: a `schema_version` column, a stored reader built with
 *   `createStoredReader`, and a golden fixture per version.
 * - `tolerant`: a structural stored reader built with `createTolerantReader`
 *   and a fixture, no version; `reason` says why a version isn't needed.
 * - `pending`: not yet migrated to either. `stored-json-registry.test.ts`
 *   fails on any `pending` entry.
 *
 * `reader` is the reader module's path relative to `packages/core/src`;
 * `fixtures` is the fixture directory relative to `packages/core/tests`.
 * `columns` are SQL column names. `stored-json-registry.test.ts` checks this
 * list against `schema.ts`.
 */

type StoredJsonEntryBase = {
  table: string;
  columns: readonly string[];
};

export type StoredJsonEntry =
  | (StoredJsonEntryBase & {
      status: "versioned";
      reader: string;
      fixtures: string;
      reason?: string;
    })
  | (StoredJsonEntryBase & {
      status: "tolerant";
      reader: string;
      fixtures: string;
      reason: string;
    })
  | (StoredJsonEntryBase & {
      status: "pending";
      reader?: string;
      fixtures?: string;
      reason?: string;
    });

export type StoredJsonStatus = StoredJsonEntry["status"];

export const storedJsonRegistry: readonly StoredJsonEntry[] = [
  {
    table: "automation_versions",
    columns: ["document"],
    status: "versioned",
    reader:
      "pipeline-definitions/automation/contracts/automation-document-stored.ts",
    fixtures: "pipeline-definitions/automation/fixtures",
  },
  {
    table: "environment_versions",
    columns: ["content_json"],
    status: "versioned",
    reader:
      "pipeline-definitions/environment/contracts/environment-content-stored.ts",
    fixtures: "pipeline-definitions/environment/fixtures",
  },
  {
    table: "task_execution_configs",
    columns: ["environment_json", "git_json", "mcp_json", "health_checks_json"],
    status: "versioned",
    reader:
      "tasks/task-execution-config/contracts/task-execution-config-stored.ts",
    fixtures: "tasks/task-execution-config/fixtures",
  },
  {
    table: "pipeline_graph_versions",
    columns: ["definition_json"],
    status: "versioned",
    reader:
      "pipeline-definitions/pipeline-graph/contracts/pipeline-graph-version-stored.ts",
    fixtures: "pipeline-definitions/pipeline-graph/fixtures",
  },
  {
    table: "managed_mcp_connections",
    columns: ["discovery"],
    status: "tolerant",
    reader:
      "connections/managed-mcp-connection/contracts/managed-connection-discovery-stored.ts",
    fixtures: "connections/managed-mcp-connection/fixtures",
    reason:
      "cache of what the provider reported; unreadable rows are re-discovered",
  },
  {
    table: "project_integrations",
    columns: ["external_scope_json"],
    status: "versioned",
    reader:
      "integrations/project-integration/contracts/project-integration-scope-stored.ts",
    fixtures: "integrations/project-integration/fixtures",
  },
  {
    table: "step_definitions",
    columns: [
      "entrypoint_json",
      "tool_call_json",
      "input_schema_json",
      "result_schema_json",
      "errors_json",
      "retry_json",
      "grants_json",
      "concurrency_json",
    ],
    status: "versioned",
    reader:
      "pipeline-definitions/step-definition/contracts/step-definition-stored.ts",
    fixtures: "pipeline-definitions/step-definition/fixtures",
  },
  {
    table: "secrets",
    columns: ["metadata_json"],
    status: "versioned",
    reader: "secrets/secret/contracts/secret-metadata-stored.ts",
    fixtures: "secrets/secret/fixtures",
  },
  {
    table: "lanes",
    columns: ["item_json", "route", "arrival_args_json", "arrival_transition"],
    status: "versioned",
    reader:
      "pipeline-executions/pipeline-run/contracts/pipeline-run-state-stored.ts",
    fixtures: "pipeline-executions/pipeline-run/fixtures",
  },
  {
    table: "node_visits",
    columns: [
      "transition",
      "routing_json",
      "input_json",
      "result_json",
      "error_json",
    ],
    status: "versioned",
    reader:
      "pipeline-executions/pipeline-run/contracts/pipeline-run-state-stored.ts",
    fixtures: "pipeline-executions/pipeline-run/fixtures",
  },
  {
    table: "pipeline_runs",
    columns: ["error_json"],
    status: "tolerant",
    reader:
      "pipeline-executions/pipeline-run/contracts/pipeline-run-state-stored.ts",
    fixtures: "pipeline-executions/pipeline-run/fixtures",
    reason:
      "loose error; engine never branches on a run's error; only `message` is read (SQL)",
  },
  {
    table: "tasks",
    columns: [
      "entrypoint_json",
      "tool_call_json",
      "result_schema_json",
      "input_json",
      "retry_json",
      "environment_selection_json",
      "grants_json",
      "result_json",
      "error_json",
    ],
    status: "versioned",
    reader: "tasks/task/contracts/task-stored.ts",
    fixtures: "tasks/task/fixtures",
  },
  {
    table: "task_runs",
    columns: ["result_json", "error_json"],
    status: "tolerant",
    reader: "tasks/task-run/contracts/task-run-stored.ts",
    fixtures: "tasks/task-run/fixtures",
    reason: "opaque results and a loose error; only pinned keys are read",
  },
  {
    table: "notification_deliveries",
    columns: ["artifact_resolution_json"],
    status: "tolerant",
    reader:
      "notifications/comment-artifacts/contracts/artifact-resolution-stored.ts",
    fixtures: "notifications/comment-artifacts/fixtures",
    reason: "delivery record; read for display and retry only",
  },
  {
    table: "work_items",
    columns: ["fields"],
    status: "tolerant",
    reader: "work-items/work-item/contracts/work-item-fields-stored.ts",
    fixtures: "work-items/work-item/fixtures",
    reason: "shape comes from the source system's form, not ours",
  },
  {
    table: "user_notifications",
    columns: ["payload_json"],
    status: "tolerant",
    reader:
      "notifications/user-notification/contracts/user-notification-payload-stored.ts",
    fixtures: "notifications/user-notification/fixtures",
    reason: "short-lived; the renderer falls back on unknown payloads",
  },
  {
    table: "notification_rules",
    columns: ["conditions_json"],
    status: "tolerant",
    reader:
      "notifications/notification-policy/contracts/notification-rule-conditions-stored.ts",
    fixtures: "notifications/notification-policy/fixtures",
    reason: "reserved; nothing reads it yet",
  },
  {
    table: "github_installations",
    columns: ["selected_repositories_json"],
    status: "tolerant",
    reader:
      "integrations/github-installation/contracts/github-installation-repositories-stored.ts",
    fixtures: "integrations/github-installation/fixtures",
    reason: "mirror of GitHub; resynced",
  },
];

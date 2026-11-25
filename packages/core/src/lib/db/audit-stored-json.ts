import { asc, gt, type InferSelectModel } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { closeDb, getDb } from "@scarn/core/lib/db";
import * as schema from "@scarn/core/lib/db/schema";
import type { StoredReadResult } from "@scarn/core/lib/db/stored-json";
import {
  storedJsonRegistry,
  type StoredJsonEntry,
} from "@scarn/core/lib/db/stored-json-registry";
import { readStoredManagedConnectionDiscovery } from "@scarn/core/connections/managed-mcp-connection/contracts/managed-connection-discovery-stored";
import { readStoredGitHubInstallationRepositories } from "@scarn/core/integrations/github-installation/contracts/github-installation-repositories-stored";
import { readProjectIntegrationRow } from "@scarn/core/integrations/project-integration/infra/drizzle-project-integration-repo";
import { readStoredAutomationDocument } from "@scarn/core/pipeline-definitions/automation/contracts/automation-document-stored";
import { readStoredEnvironmentContent } from "@scarn/core/pipeline-definitions/environment/contracts/environment-content-stored";
import {
  readStoredArtifactResolution,
  readStoredArtifactResolutionJson,
} from "@scarn/core/notifications/comment-artifacts/contracts/artifact-resolution-stored";
import { readStoredNotificationRuleConditions } from "@scarn/core/notifications/notification-policy/contracts/notification-rule-conditions-stored";
import { readStoredUserNotificationPayload } from "@scarn/core/notifications/user-notification/contracts/user-notification-payload-stored";
import { readStoredPipelineDocument } from "@scarn/core/pipeline-definitions/pipeline-graph/contracts/pipeline-graph-version-stored";
import {
  readLaneRow,
  readRunRow,
  readVisitRow,
} from "@scarn/core/pipeline-executions/pipeline-run/infra/pipeline-run-row-mappers";
import { readStepDefinitionRow } from "@scarn/core/pipeline-definitions/step-definition/infra/drizzle-step-definition-repo";
import { readSecretRow } from "@scarn/core/secrets/secret/infra/drizzle-secret-repo";
import { readStoredTaskExecutionConfig } from "@scarn/core/tasks/task-execution-config/contracts/task-execution-config-stored";
import { readTaskRow } from "@scarn/core/tasks/task/infra/drizzle-task-repo";
import { readStoredTaskRun } from "@scarn/core/tasks/task-run/contracts/task-run-stored";
import { readStoredWorkItemFields } from "@scarn/core/work-items/work-item/contracts/work-item-fields-stored";

/**
 * Reads every row of every table in `storedJsonRegistry` through that
 * table's stored reader (or, while the entry is `pending`, through today's
 * read path) and prints, per table, the row count, the number of unreadable
 * rows and each distinct failure reason with its count. Row contents are
 * never printed: each reader reports why a row doesn't fit, not its values.
 *
 * Run it against a prod snapshot before each phase of
 * `docs/plans/json-column-versioning.md`; the output decides what each
 * table's v1 reader must accept:
 *
 *   cd packages/core && bun --env-file=../../.env src/lib/db/audit-stored-json.ts
 *
 * Exits non-zero when a registered table has no entry in `auditors` below.
 * When a table gets a stored reader, point its entry at that reader.
 */

type AuditRead = StoredReadResult<unknown>;

type TableAuditor = {
  /** How the row is read; `null` while nothing parses it (a plain cast). */
  readPath: string | null;
  readAll: () => AsyncIterable<AuditRead[]>;
};

const pageSize = 1000;

const normalizeReason = (reason: string): string =>
  reason.replace(/\[\d+\]/g, "[*]").replace(/\.\d+(?=\.|\s|$)/g, ".[*]");

type TableWithId = PgTable & { id: PgColumn };

const auditTable = <TTable extends TableWithId>(
  table: TTable,
  readPath: string | null,
  read?: (row: InferSelectModel<TTable>) => AuditRead,
): TableAuditor => ({
  readPath,
  async *readAll() {
    let after: string | null = null;
    for (;;) {
      const page = (await getDb()
        .select()
        .from(table)
        .where(after === null ? undefined : gt(table.id, after))
        .orderBy(asc(table.id))
        .limit(pageSize)) as (InferSelectModel<TTable> & { id: string })[];
      if (page.length === 0) {
        return;
      }
      yield page.map((row) =>
        read ? read(row) : { success: true, value: undefined },
      );
      after = page[page.length - 1]?.id ?? null;
      if (page.length < pageSize) {
        return;
      }
    }
  },
});

/** One entry per registered table, keyed by SQL table name. */
const auditors: Record<string, TableAuditor> = {
  automation_versions: auditTable(
    schema.automationVersions,
    "readStoredAutomationDocument",
    (row) => readStoredAutomationDocument(row.schemaVersion, row),
  ),
  environment_versions: auditTable(
    schema.environmentVersions,
    "readStoredEnvironmentContent",
    (row) => readStoredEnvironmentContent(row.schemaVersion, row),
  ),
  task_execution_configs: auditTable(
    schema.taskExecutionConfigs,
    "readStoredTaskExecutionConfig",
    (row) => {
      const read = readStoredTaskExecutionConfig(row.schemaVersion, row);
      return read.success ? { success: true, value: read.content } : read;
    },
  ),
  pipeline_graph_versions: auditTable(
    schema.pipelineGraphVersions,
    "readStoredPipelineDocument",
    (row) => readStoredPipelineDocument(row.schemaVersion, row),
  ),
  managed_mcp_connections: auditTable(
    schema.managedMcpConnections,
    "readStoredManagedConnectionDiscovery",
    (row) => readStoredManagedConnectionDiscovery(row.discovery),
  ),
  project_integrations: auditTable(
    schema.projectIntegrations,
    "readProjectIntegrationRow (readStoredProjectIntegrationScope, then fromStored)",
    (row) => readProjectIntegrationRow(row),
  ),
  step_definitions: auditTable(
    schema.stepDefinitions,
    "readStepDefinitionRow (readStoredStepDefinition, then rehydrate)",
    (row) => readStepDefinitionRow(row),
  ),
  secrets: auditTable(
    schema.secrets,
    "readSecretRow (readStoredSecretMetadata, then fromStored)",
    (row) => readSecretRow(row),
  ),
  tasks: auditTable(
    schema.tasks,
    "readTaskRow (readStoredTask, then rehydrate)",
    (row) => readTaskRow(row),
  ),
  lanes: auditTable(schema.lanes, "readLaneRow (readStoredLane)", (row) =>
    readLaneRow(row),
  ),
  node_visits: auditTable(
    schema.nodeVisits,
    "readVisitRow (readStoredNodeVisit, then rehydrate)",
    (row) => readVisitRow(row),
  ),
  pipeline_runs: auditTable(
    schema.pipelineRuns,
    "readRunRow (readStoredPipelineRunError)",
    (row) => readRunRow(row),
  ),
  task_runs: auditTable(schema.taskRuns, "readStoredTaskRun", (row) =>
    readStoredTaskRun(row),
  ),
  notification_deliveries: auditTable(
    schema.notificationDeliveries,
    "readStoredArtifactResolutionJson, then readStoredArtifactResolution",
    (row) => {
      const read = readStoredArtifactResolutionJson(row.artifactResolutionJson);
      return read.success && read.value !== null
        ? readStoredArtifactResolution(read.value)
        : read;
    },
  ),
  work_items: auditTable(schema.workItems, "readStoredWorkItemFields", (row) =>
    readStoredWorkItemFields(row.fields),
  ),
  user_notifications: auditTable(
    schema.userNotifications,
    "readStoredUserNotificationPayload",
    (row) => readStoredUserNotificationPayload(row.payloadJson),
  ),
  notification_rules: auditTable(
    schema.notificationRules,
    "readStoredNotificationRuleConditions",
    (row) => readStoredNotificationRuleConditions(row.conditionsJson),
  ),
  github_installations: auditTable(
    schema.githubInstallations,
    "readStoredGitHubInstallationRepositories",
    (row) =>
      readStoredGitHubInstallationRepositories(row.selectedRepositoriesJson),
  ),
};

type TableReport = {
  rows: number;
  unreadable: number;
  reasons: Map<string, number>;
};

const auditEntry = async (auditor: TableAuditor): Promise<TableReport> => {
  const report: TableReport = { rows: 0, unreadable: 0, reasons: new Map() };
  for await (const page of auditor.readAll()) {
    for (const read of page) {
      report.rows += 1;
      if (!read.success) {
        report.unreadable += 1;
        const reason = normalizeReason(read.reason);
        report.reasons.set(reason, (report.reasons.get(reason) ?? 0) + 1);
      }
    }
  }
  return report;
};

const write = (line: string) => {
  process.stdout.write(`${line}\n`);
};

const printReport = (
  entry: StoredJsonEntry,
  auditor: TableAuditor,
  report: TableReport,
) => {
  write(
    `${entry.table} [${entry.status}] rows=${String(report.rows)} unreadable=${String(report.unreadable)}`,
  );
  write(`  read path: ${auditor.readPath ?? "pending: no reader (cast)"}`);
  for (const [reason, count] of [...report.reasons].sort(
    (a, b) => b[1] - a[1],
  )) {
    write(`  ${String(count)}x ${reason.replace(/\n/g, "\n     ")}`);
  }
};

const main = async (): Promise<number> => {
  let exitCode = 0;
  for (const entry of storedJsonRegistry) {
    const auditor = auditors[entry.table];
    if (!auditor) {
      write(
        `${entry.table} [${entry.status}] has no auditor in audit-stored-json.ts`,
      );
      exitCode = 1;
      continue;
    }
    printReport(entry, auditor, await auditEntry(auditor));
  }
  return exitCode;
};

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } finally {
    await closeDb();
  }
}

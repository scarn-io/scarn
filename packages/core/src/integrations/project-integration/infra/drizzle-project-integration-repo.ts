import {
  and,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  CoreError,
  CoreValidationError,
  PersistenceError,
} from "@scarn/core/lib/errors";
import { projectIntegrations } from "@scarn/core/lib/db/schema";
import {
  readRowsSkippingUnreadable,
  type StoredReadResult,
} from "@scarn/core/lib/db/stored-json";
import { noopLogger, type Logger } from "@scarn/observability/logging";
import type { ProjectIntegrationRepo } from "../application/project-integration-repo";
import {
  CURRENT_PROJECT_INTEGRATION_SCHEMA_VERSION,
  readStoredProjectIntegrationScope,
} from "../contracts/project-integration-scope-stored";
import {
  AUTO_SYNC_PAUSED_REASONS,
  PROJECT_INTEGRATION_STATUSES,
  ProjectIntegrationEntity,
  isGitHubAppIntegration,
  type AutoSyncPausedReason,
  type GitHubAppProjectIntegration,
  type ProjectIntegrationStatus,
} from "../domain/project-integration-entity";

const parseStatus = (value: string): ProjectIntegrationStatus =>
  (PROJECT_INTEGRATION_STATUSES as readonly string[]).includes(value)
    ? (value as ProjectIntegrationStatus)
    : "active";

const parseAutoSyncPausedReason = (
  value: string | null,
): AutoSyncPausedReason | null => {
  if (value === null) {
    return null;
  }
  if (!(AUTO_SYNC_PAUSED_REASONS as readonly string[]).includes(value)) {
    throw new CoreValidationError(
      `Project integration row has an unknown auto-sync paused reason '${value}'`,
      "PROJECT_INTEGRATION_ROW_INVALID",
    );
  }
  return value as AutoSyncPausedReason;
};

const toRow = (integration: ProjectIntegrationEntity) => {
  const row = integration.toJSON();
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    installationId: row.installationId,
    externalScopeJson: row.externalScopeJson,
    schemaVersion: CURRENT_PROJECT_INTEGRATION_SCHEMA_VERSION,
    status: row.status,
    lastSyncedAt: row.lastSyncedAt,
    lastError: row.lastError,
    firstSyncHorizonDays: row.firstSyncHorizonDays,
    syncSecretId: row.syncSecretId,
    autoSyncPausedReason: row.autoSyncPausedReason,
    autoSyncPausedAt: row.autoSyncPausedAt,
    autoSyncPausedDetail: row.autoSyncPausedDetail,
    createdAt: row.createdAt ?? new Date(),
    updatedAt: row.updatedAt ?? new Date(),
  };
};

/**
 * Page size for `listActive()` / `listDueForAutoSync()` internal keyset pagination. Overridable via
 * the (test-only) `pageSize` option so tests can exercise multi-page
 * traversal without seeding hundreds of rows.
 */
export const LIST_ACTIVE_DEFAULT_PAGE_SIZE = 500;

type ProjectIntegrationRow = typeof projectIntegrations.$inferSelect;

/**
 * Reads a row through the stored scope reader. A row whose scope, kind,
 * installation id or other columns don't fit is unreadable.
 */
export const readProjectIntegrationRow = (
  row: ProjectIntegrationRow,
): StoredReadResult<ProjectIntegrationEntity> => {
  const scope = readStoredProjectIntegrationScope(row.schemaVersion, row);
  if (!scope.success) {
    return scope;
  }
  try {
    return {
      success: true,
      value: ProjectIntegrationEntity.fromStored({
        ...scope.value,
        id: parseUuidV7(row.id),
        projectId: parseUuidV7(row.projectId),
        installationId: row.installationId,
        status: parseStatus(row.status),
        lastSyncedAt: row.lastSyncedAt,
        lastError: row.lastError,
        firstSyncHorizonDays: row.firstSyncHorizonDays,
        syncSecretId:
          row.syncSecretId === null ? null : parseUuidV7(row.syncSecretId),
        autoSyncPausedReason: parseAutoSyncPausedReason(
          row.autoSyncPausedReason,
        ),
        autoSyncPausedAt: row.autoSyncPausedAt,
        autoSyncPausedDetail: row.autoSyncPausedDetail,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }),
    };
  } catch (error: unknown) {
    if (error instanceof CoreError) {
      return { success: false, reason: error.message };
    }
    throw error;
  }
};

/** A row that does not read is a persistence fault: this code wrote it. */
export const projectIntegrationFromRow = (
  row: ProjectIntegrationRow,
): ProjectIntegrationEntity => {
  const read = readProjectIntegrationRow(row);
  if (!read.success) {
    throw new PersistenceError(
      `project integration ${row.id} is unreadable: ${read.reason}`,
      "PROJECT_INTEGRATION_ROW_UNREADABLE",
    );
  }
  return read.value;
};

/** The log fields that identify a skipped row. */
const describeRow = (row: ProjectIntegrationRow) => ({
  table: "project_integrations",
  projectIntegrationId: row.id,
  projectId: row.projectId,
  kind: row.kind,
});

/**
 * Single-row reads throw `PROJECT_INTEGRATION_ROW_UNREADABLE` on a row that
 * doesn't read; list reads log it at `error` with the integration id and
 * leave it out, so one bad row doesn't stop the sync tick or the project's
 * integration list.
 */
export class DrizzleProjectIntegrationRepo implements ProjectIntegrationRepo {
  constructor(private readonly logger: Logger = noopLogger) {}

  private readRows(
    rows: readonly ProjectIntegrationRow[],
  ): ProjectIntegrationEntity[] {
    return readRowsSkippingUnreadable(
      rows,
      readProjectIntegrationRow,
      this.logger,
      describeRow,
    );
  }

  async create(
    integration: ProjectIntegrationEntity,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectIntegrationEntity> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .insert(projectIntegrations)
      .values(toRow(integration))
      .returning();
    if (!row) {
      throw new Error("Failed to create project integration");
    }
    return projectIntegrationFromRow(row);
  }

  async save(
    integration: ProjectIntegrationEntity,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectIntegrationEntity> {
    const db = dbExecutor ?? getDb();
    const row = toRow(integration);
    const [updated] = await db
      .update(projectIntegrations)
      .set({
        externalScopeJson: row.externalScopeJson,
        schemaVersion: row.schemaVersion,
        status: row.status,
        lastSyncedAt: row.lastSyncedAt,
        lastError: row.lastError,
        firstSyncHorizonDays: row.firstSyncHorizonDays,
        syncSecretId: row.syncSecretId,
        autoSyncPausedReason: row.autoSyncPausedReason,
        autoSyncPausedAt: row.autoSyncPausedAt,
        autoSyncPausedDetail: row.autoSyncPausedDetail,
        updatedAt: new Date(),
      })
      .where(eq(projectIntegrations.id, integration.id))
      .returning();
    if (!updated) {
      throw new Error("Failed to update project integration");
    }
    return projectIntegrationFromRow(updated);
  }

  async findById(
    id: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectIntegrationEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(projectIntegrations)
      .where(eq(projectIntegrations.id, id))
      .limit(1);
    return row ? projectIntegrationFromRow(row) : null;
  }

  async listByProjectId(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectIntegrationEntity[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(projectIntegrations)
      .where(eq(projectIntegrations.projectId, projectId))
      .orderBy(projectIntegrations.createdAt);
    return this.readRows(rows);
  }

  async findByInstallationId(
    installationId: string,
    dbExecutor?: DbExecutor,
  ): Promise<GitHubAppProjectIntegration[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(projectIntegrations)
      .where(
        and(
          eq(projectIntegrations.kind, "github_app"),
          eq(projectIntegrations.installationId, installationId),
        ),
      )
      .orderBy(projectIntegrations.createdAt);
    return rows
      .map((row) => projectIntegrationFromRow(row))
      .filter(isGitHubAppIntegration);
  }

  /**
   * Returns every active-or-error-status integration, paging through the
   * table internally via keyset (cursor) pagination on `id` (a UUIDv7, so
   * ordering by it also orders by creation time) rather than issuing a
   * single unbounded `select`. Callers see one flat array; the paging is an
   * implementation detail.
   */
  async listActive(
    dbExecutor?: DbExecutor,
    options?: { pageSize?: number },
  ): Promise<ProjectIntegrationEntity[]> {
    return this.listPaged(
      inArray(projectIntegrations.status, ["active", "error"]),
      dbExecutor,
      options,
    );
  }

  async listDueForAutoSync(
    dbExecutor?: DbExecutor,
    options?: { pageSize?: number },
  ): Promise<ProjectIntegrationEntity[]> {
    return this.listPaged(
      and(
        isNotNull(projectIntegrations.syncSecretId),
        inArray(projectIntegrations.status, ["active", "error"]),
      ),
      dbExecutor,
      options,
    );
  }

  async listBySyncSecretId(
    secretId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectIntegrationEntity[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(projectIntegrations)
      .where(eq(projectIntegrations.syncSecretId, secretId))
      .orderBy(projectIntegrations.id);
    return rows.map((row) => projectIntegrationFromRow(row));
  }

  async listBySyncSecretIds(
    secretIds: UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<ProjectIntegrationEntity[]> {
    if (secretIds.length === 0) {
      return [];
    }
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(projectIntegrations)
      .where(inArray(projectIntegrations.syncSecretId, secretIds))
      .orderBy(projectIntegrations.id);
    return this.readRows(rows);
  }

  async claimForSync(
    id: UuidV7,
    until: Date,
    dbExecutor?: DbExecutor,
  ): Promise<boolean> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .update(projectIntegrations)
      .set({ syncLockedUntil: until })
      .where(
        and(
          eq(projectIntegrations.id, id),
          or(
            isNull(projectIntegrations.syncLockedUntil),
            lt(projectIntegrations.syncLockedUntil, sql`now()`),
          ),
        ),
      )
      .returning({ id: projectIntegrations.id });
    return rows.length > 0;
  }

  async releaseSyncClaim(id: UuidV7, dbExecutor?: DbExecutor): Promise<void> {
    const db = dbExecutor ?? getDb();
    await db
      .update(projectIntegrations)
      .set({ syncLockedUntil: null })
      .where(eq(projectIntegrations.id, id));
  }

  private async listPaged(
    filter: SQL | undefined,
    dbExecutor?: DbExecutor,
    options?: { pageSize?: number },
  ): Promise<ProjectIntegrationEntity[]> {
    const db = dbExecutor ?? getDb();
    const pageSize = options?.pageSize ?? LIST_ACTIVE_DEFAULT_PAGE_SIZE;

    const results: ProjectIntegrationEntity[] = [];
    let cursor: string | null = null;
    for (;;) {
      const rows = await db
        .select()
        .from(projectIntegrations)
        .where(
          cursor ? and(filter, gt(projectIntegrations.id, cursor)) : filter,
        )
        .orderBy(projectIntegrations.id)
        .limit(pageSize);

      results.push(...this.readRows(rows));

      if (rows.length < pageSize) break;
      cursor = rows[rows.length - 1]?.id ?? null;
      if (!cursor) break;
    }

    return results;
  }

  async delete(
    id: UuidV7,
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<number> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .delete(projectIntegrations)
      .where(
        and(
          eq(projectIntegrations.id, id),
          eq(projectIntegrations.projectId, projectId),
        ),
      )
      .returning({ id: projectIntegrations.id });
    return rows.length;
  }

  async deleteByInstallationId(
    installationId: string,
    dbExecutor?: DbExecutor,
  ): Promise<number> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .delete(projectIntegrations)
      .where(
        and(
          eq(projectIntegrations.kind, "github_app"),
          eq(projectIntegrations.installationId, installationId),
        ),
      )
      .returning({ id: projectIntegrations.id });
    return rows.length;
  }
}

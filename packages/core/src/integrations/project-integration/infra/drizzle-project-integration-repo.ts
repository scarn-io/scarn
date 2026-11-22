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
import { anyJsonValueSchema } from "@scarn/core/common/contracts/json";
import { CoreValidationError } from "@scarn/core/lib/errors";
import { projectIntegrations } from "@scarn/core/lib/db/schema";
import type { ProjectIntegrationRepo } from "../application/project-integration-repo";
import {
  AUTO_SYNC_PAUSED_REASONS,
  PROJECT_INTEGRATION_KINDS,
  PROJECT_INTEGRATION_STATUSES,
  ProjectIntegrationEntity,
  isGitHubAppIntegration,
  type AutoSyncPausedReason,
  type GitHubAppProjectIntegration,
  type ProjectIntegrationKind,
  type ProjectIntegrationStatus,
} from "../domain/project-integration-entity";

const parseStatus = (value: string): ProjectIntegrationStatus =>
  (PROJECT_INTEGRATION_STATUSES as readonly string[]).includes(value)
    ? (value as ProjectIntegrationStatus)
    : "active";

const parseKind = (value: string): ProjectIntegrationKind => {
  if (!(PROJECT_INTEGRATION_KINDS as readonly string[]).includes(value)) {
    throw new CoreValidationError(
      `Project integration row of kind '${value}' is invalid: unsupported kind`,
      "PROJECT_INTEGRATION_ROW_INVALID",
    );
  }
  return value as ProjectIntegrationKind;
};

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

export class DrizzleProjectIntegrationRepo implements ProjectIntegrationRepo {
  private toEntity(
    row: typeof projectIntegrations.$inferSelect,
  ): ProjectIntegrationEntity {
    return ProjectIntegrationEntity.rehydrate({
      id: parseUuidV7(row.id),
      projectId: parseUuidV7(row.projectId),
      kind: parseKind(row.kind),
      installationId: row.installationId,
      externalScopeJson: anyJsonValueSchema.parse(row.externalScopeJson),
      status: parseStatus(row.status),
      lastSyncedAt: row.lastSyncedAt,
      lastError: row.lastError,
      firstSyncHorizonDays: row.firstSyncHorizonDays,
      syncSecretId:
        row.syncSecretId === null ? null : parseUuidV7(row.syncSecretId),
      autoSyncPausedReason: parseAutoSyncPausedReason(row.autoSyncPausedReason),
      autoSyncPausedAt: row.autoSyncPausedAt,
      autoSyncPausedDetail: row.autoSyncPausedDetail,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
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
    return this.toEntity(row);
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
    return this.toEntity(updated);
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
    return row ? this.toEntity(row) : null;
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
    return rows.map((row) => this.toEntity(row));
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
    return rows.map((row) => this.toEntity(row)).filter(isGitHubAppIntegration);
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
    return rows.map((row) => this.toEntity(row));
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
    return rows.map((row) => this.toEntity(row));
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

      for (const row of rows) {
        results.push(this.toEntity(row));
      }

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

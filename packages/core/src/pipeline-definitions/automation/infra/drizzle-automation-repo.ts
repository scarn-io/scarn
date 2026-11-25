import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { automations, automationVersions } from "@scarn/core/lib/db/schema";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  readRowsSkippingUnreadable,
  type StoredReadResult,
} from "@scarn/core/lib/db/stored-json";
import { PersistenceError } from "@scarn/core/lib/errors";
import { noopLogger, type Logger } from "@scarn/observability/logging";
import type { AutomationScope } from "@scarn/sdk/contracts/automation-document";
import { readStoredAutomationDocument } from "../contracts/automation-document-stored";
import type {
  AutomationRepo,
  ResolvedAutomation,
} from "../application/automation-repo";
import { AutomationEntity } from "../domain/automation-entity";
import { AutomationVersionEntity } from "../domain/automation-version-entity";

type AutomationRow = typeof automations.$inferSelect;
type VersionRow = typeof automationVersions.$inferSelect;

export const automationRowToEntity = (row: AutomationRow): AutomationEntity =>
  AutomationEntity.rehydrate({
    id: parseUuidV7(row.id),
    projectId: parseUuidV7(row.projectId),
    key: row.key,
    title: row.title,
    scope: row.scope,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

/** Reads the version's `document` through its version's stored schema. */
const readVersionRow = (
  row: VersionRow,
): StoredReadResult<AutomationVersionEntity> => {
  const read = readStoredAutomationDocument(row.schemaVersion, row);
  if (!read.success) {
    return read;
  }
  return {
    success: true,
    value: AutomationVersionEntity.rehydrate({
      id: parseUuidV7(row.id),
      automationId: parseUuidV7(row.automationId),
      version: row.version,
      document: read.value,
      schemaVersion: row.schemaVersion,
      contentHash: row.contentHash,
      publishedAt: row.publishedAt,
    }),
  };
};

/** A row that does not parse is a persistence fault: this code wrote it. */
export const automationVersionFromRow = (
  row: VersionRow,
): AutomationVersionEntity => {
  const read = readVersionRow(row);
  if (!read.success) {
    throw new PersistenceError(
      `automation version ${row.id} is unreadable: ${read.reason}`,
      "AUTOMATION_VERSION_ROW_UNREADABLE",
    );
  }
  return read.value;
};

/**
 * The latest version of each of `automationIds`, by automation id. An
 * unreadable version is logged and left out, so one bad row doesn't stop
 * every other automation from loading.
 */
export const loadLatestAutomationVersions = async (
  automationIds: readonly string[],
  db: DbExecutor,
  logger: Logger,
): Promise<Map<string, AutomationVersionEntity>> => {
  if (automationIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .selectDistinctOn([automationVersions.automationId])
    .from(automationVersions)
    .where(inArray(automationVersions.automationId, [...automationIds]))
    .orderBy(automationVersions.automationId, desc(automationVersions.version));
  const versions = readRowsSkippingUnreadable(
    rows,
    readVersionRow,
    logger,
    (row) => ({
      table: "automation_versions",
      automationId: row.automationId,
      automationVersionId: row.id,
    }),
  );
  return new Map(
    versions.map((version) => [version.automationId, version] as const),
  );
};

/** Pairs each automation row with its latest readable version, keeping row order. */
export const resolveAutomations = async (
  rows: readonly AutomationRow[],
  db: DbExecutor,
  logger: Logger,
): Promise<ResolvedAutomation[]> => {
  const latest = await loadLatestAutomationVersions(
    rows.map((row) => row.id),
    db,
    logger,
  );
  return rows.map((row) => ({
    automation: automationRowToEntity(row),
    latestVersion: latest.get(row.id) ?? null,
  }));
};

export class DrizzleAutomationRepo implements AutomationRepo {
  constructor(private readonly logger: Logger = noopLogger) {}

  async findByKey(
    projectId: UuidV7,
    key: string,
    dbExecutor?: DbExecutor,
  ): Promise<AutomationEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(automations)
      .where(
        and(eq(automations.projectId, projectId), eq(automations.key, key)),
      )
      .limit(1);
    return row ? automationRowToEntity(row) : null;
  }

  async lockByKey(
    projectId: UuidV7,
    key: string,
    dbExecutor: DbExecutor,
  ): Promise<AutomationEntity | null> {
    const [row] = await dbExecutor
      .select()
      .from(automations)
      .where(
        and(eq(automations.projectId, projectId), eq(automations.key, key)),
      )
      .limit(1)
      .for("update");
    return row ? automationRowToEntity(row) : null;
  }

  async loadMany(
    ids: readonly UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<AutomationEntity[]> {
    if (ids.length === 0) {
      return [];
    }
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(automations)
      .where(inArray(automations.id, [...ids]))
      .orderBy(asc(automations.key));
    return rows.map(automationRowToEntity);
  }

  async listByProjectId(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ResolvedAutomation[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(automations)
      .where(eq(automations.projectId, projectId))
      .orderBy(asc(automations.key));
    return await resolveAutomations(rows, db, this.logger);
  }

  async listEnabledProjectAutomations(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ResolvedAutomation[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(automations)
      .where(
        and(
          eq(automations.projectId, projectId),
          eq(automations.scope, "project"),
          eq(automations.enabled, true),
        ),
      )
      .orderBy(asc(automations.key));
    return await resolveAutomations(rows, db, this.logger);
  }

  async scopesByKey(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<Map<string, AutomationScope>> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select({ key: automations.key, scope: automations.scope })
      .from(automations)
      .where(eq(automations.projectId, projectId));
    return new Map(rows.map((row) => [row.key, row.scope]));
  }

  async insert(
    automation: AutomationEntity,
    dbExecutor?: DbExecutor,
  ): Promise<AutomationEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .insert(automations)
      .values({
        id: automation.id,
        projectId: automation.projectId,
        key: automation.key,
        title: automation.title,
        scope: automation.scope,
        enabled: automation.enabled,
      })
      .onConflictDoNothing({ target: [automations.projectId, automations.key] })
      .returning();
    return row ? automationRowToEntity(row) : null;
  }

  async update(
    automation: AutomationEntity,
    dbExecutor?: DbExecutor,
  ): Promise<AutomationEntity> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .update(automations)
      .set({
        title: automation.title,
        enabled: automation.enabled,
        updatedAt: automation.updatedAt ?? new Date(),
      })
      .where(eq(automations.id, automation.id))
      .returning();
    if (!row) {
      throw new PersistenceError(`Automation ${automation.id} was not updated`);
    }
    return automationRowToEntity(row);
  }

  async loadLatestVersion(
    automationId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<AutomationVersionEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(automationVersions)
      .where(eq(automationVersions.automationId, automationId))
      .orderBy(desc(automationVersions.version))
      .limit(1);
    return row ? automationVersionFromRow(row) : null;
  }

  async insertVersion(
    version: AutomationVersionEntity,
    dbExecutor?: DbExecutor,
  ): Promise<AutomationVersionEntity> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .insert(automationVersions)
      .values({
        id: version.id,
        automationId: version.automationId,
        version: version.version,
        document: version.document,
        schemaVersion: version.schemaVersion,
        contentHash: version.contentHash,
        publishedAt: version.publishedAt,
      })
      .returning();
    if (!row) {
      throw new PersistenceError(
        `Automation version ${version.id} was not inserted`,
      );
    }
    return automationVersionFromRow(row);
  }
}

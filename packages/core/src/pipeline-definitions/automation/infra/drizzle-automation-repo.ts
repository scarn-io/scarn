import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { automations, automationVersions } from "@scarn/core/lib/db/schema";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { PersistenceError } from "@scarn/core/lib/errors";
import {
  automationDocumentSchema,
  type AutomationScope,
} from "@scarn/sdk/contracts/automation-document";
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

const versionRowToEntity = (row: VersionRow): AutomationVersionEntity =>
  AutomationVersionEntity.rehydrate({
    id: parseUuidV7(row.id),
    automationId: parseUuidV7(row.automationId),
    version: row.version,
    document: automationDocumentSchema.parse(row.document),
    schemaVersion: row.schemaVersion,
    contentHash: row.contentHash,
    publishedAt: row.publishedAt,
  });

/** The latest version of each of `automationIds`, by automation id. */
export const loadLatestAutomationVersions = async (
  automationIds: readonly string[],
  db: DbExecutor,
): Promise<Map<string, AutomationVersionEntity>> => {
  if (automationIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .selectDistinctOn([automationVersions.automationId])
    .from(automationVersions)
    .where(inArray(automationVersions.automationId, [...automationIds]))
    .orderBy(automationVersions.automationId, desc(automationVersions.version));
  return new Map(
    rows.map((row) => [row.automationId, versionRowToEntity(row)]),
  );
};

/** Pairs each automation row with its latest version, keeping row order. */
export const resolveAutomations = async (
  rows: readonly AutomationRow[],
  db: DbExecutor,
): Promise<ResolvedAutomation[]> => {
  const latest = await loadLatestAutomationVersions(
    rows.map((row) => row.id),
    db,
  );
  return rows.map((row) => ({
    automation: automationRowToEntity(row),
    latestVersion: latest.get(row.id) ?? null,
  }));
};

export class DrizzleAutomationRepo implements AutomationRepo {
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
    return await resolveAutomations(rows, db);
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
    return await resolveAutomations(rows, db);
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
    return row ? versionRowToEntity(row) : null;
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
    return versionRowToEntity(row);
  }
}

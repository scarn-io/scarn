import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  environments,
  environmentVersions,
  stepDefinitions,
  taskExecutionConfigs,
} from "@scarn/core/lib/db/schema";
import { PersistenceError } from "@scarn/core/lib/errors";
import type {
  EnvironmentRepo,
  EnvironmentWithLatestVersion,
  EnvironmentWithVersion,
} from "../application/environment-repo";
import {
  CURRENT_ENVIRONMENT_CONTENT_SCHEMA_VERSION,
  readStoredEnvironmentContent,
} from "../contracts/environment-content-stored";
import { EnvironmentEntity } from "../domain/environment-entity";
import { EnvironmentVersionEntity } from "../domain/environment-version-entity";

const environmentFromRow = (
  row: typeof environments.$inferSelect,
): EnvironmentEntity =>
  EnvironmentEntity.rehydrate({
    id: parseUuidV7(row.id),
    projectId: parseUuidV7(row.projectId),
    name: row.name,
    latestVersion: row.latestVersion,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

/**
 * Reads the version's `content_json` through its version's stored schema. A
 * row that does not parse is a persistence fault: this code wrote it.
 */
export const environmentVersionFromRow = (
  row: typeof environmentVersions.$inferSelect,
): EnvironmentVersionEntity => {
  const read = readStoredEnvironmentContent(row.schemaVersion, row);
  if (!read.success) {
    throw new PersistenceError(
      `environment version ${row.id} is unreadable: ${read.reason}`,
      "ENVIRONMENT_VERSION_ROW_UNREADABLE",
    );
  }
  return EnvironmentVersionEntity.rehydrate({
    id: parseUuidV7(row.id),
    environmentId: parseUuidV7(row.environmentId),
    version: row.version,
    content: read.value,
    contentHash: row.contentHash,
    createdByUserId: parseUuidV7(row.createdByUserId),
    createdAt: row.createdAt,
  });
};

const toEnvironmentRow = (
  environment: EnvironmentEntity,
): typeof environments.$inferInsert => ({
  id: environment.id,
  projectId: environment.projectId,
  name: environment.name,
  latestVersion: environment.latestVersion,
  deletedAt: environment.deletedAt,
  createdAt: environment.createdAt,
  updatedAt: environment.updatedAt,
});

export class DrizzleEnvironmentRepo implements EnvironmentRepo {
  async findByName(projectId: UuidV7, name: string, dbExecutor?: DbExecutor) {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(environments)
      .where(
        and(eq(environments.projectId, projectId), eq(environments.name, name)),
      )
      .limit(1);
    return row ? environmentFromRow(row) : null;
  }

  async lockOrCreate(candidate: EnvironmentEntity, dbExecutor: DbExecutor) {
    await dbExecutor
      .insert(environments)
      .values(toEnvironmentRow(candidate))
      .onConflictDoNothing({
        target: [environments.projectId, environments.name],
      });
    const [row] = await dbExecutor
      .select()
      .from(environments)
      .where(
        and(
          eq(environments.projectId, candidate.projectId),
          eq(environments.name, candidate.name),
        ),
      )
      .limit(1)
      .for("update");
    if (!row) {
      throw new PersistenceError(
        `Failed to find or create environment ${candidate.projectId}/${candidate.name}`,
        "ENVIRONMENT_CREATE_FAILED",
      );
    }
    return environmentFromRow(row);
  }

  async save(environment: EnvironmentEntity, dbExecutor?: DbExecutor) {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .update(environments)
      .set({
        latestVersion: environment.latestVersion,
        deletedAt: environment.deletedAt,
        updatedAt: environment.updatedAt,
      })
      .where(eq(environments.id, environment.id))
      .returning();
    if (!row) {
      throw new PersistenceError(
        `Failed to save environment ${environment.id}`,
        "ENVIRONMENT_SAVE_FAILED",
      );
    }
    return environmentFromRow(row);
  }

  async listLiveWithLatestVersion(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<EnvironmentWithLatestVersion[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select({ environment: environments, version: environmentVersions })
      .from(environments)
      .innerJoin(
        environmentVersions,
        and(
          eq(environmentVersions.environmentId, environments.id),
          eq(environmentVersions.version, environments.latestVersion),
        ),
      )
      .where(
        and(
          eq(environments.projectId, projectId),
          isNull(environments.deletedAt),
        ),
      )
      .orderBy(asc(environments.name));
    return rows.map((row) => ({
      environment: environmentFromRow(row.environment),
      latestVersion: environmentVersionFromRow(row.version),
    }));
  }

  async findLiveWithLatestVersionByName(
    projectId: UuidV7,
    name: string,
    dbExecutor?: DbExecutor,
  ): Promise<EnvironmentWithLatestVersion | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select({ environment: environments, version: environmentVersions })
      .from(environments)
      .innerJoin(
        environmentVersions,
        and(
          eq(environmentVersions.environmentId, environments.id),
          eq(environmentVersions.version, environments.latestVersion),
        ),
      )
      .where(
        and(
          eq(environments.projectId, projectId),
          eq(environments.name, name),
          isNull(environments.deletedAt),
        ),
      )
      .limit(1)
      .for("share");
    return row
      ? {
          environment: environmentFromRow(row.environment),
          latestVersion: environmentVersionFromRow(row.version),
        }
      : null;
  }

  async findVersionById(
    versionId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<EnvironmentWithVersion | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select({ environment: environments, version: environmentVersions })
      .from(environmentVersions)
      .innerJoin(
        environments,
        eq(environments.id, environmentVersions.environmentId),
      )
      .where(eq(environmentVersions.id, versionId))
      .limit(1);
    return row
      ? {
          environment: environmentFromRow(row.environment),
          version: environmentVersionFromRow(row.version),
        }
      : null;
  }

  async loadVersion(
    environmentId: UuidV7,
    version: number,
    dbExecutor?: DbExecutor,
  ) {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(environmentVersions)
      .where(
        and(
          eq(environmentVersions.environmentId, environmentId),
          eq(environmentVersions.version, version),
        ),
      )
      .limit(1);
    return row ? environmentVersionFromRow(row) : null;
  }

  async insertVersion(
    version: EnvironmentVersionEntity,
    dbExecutor?: DbExecutor,
  ) {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .insert(environmentVersions)
      .values({
        id: version.id,
        environmentId: version.environmentId,
        version: version.version,
        schemaVersion: CURRENT_ENVIRONMENT_CONTENT_SCHEMA_VERSION,
        contentJson: version.content,
        contentHash: version.contentHash,
        createdByUserId: version.createdByUserId,
        createdAt: version.createdAt,
      })
      .returning();
    if (!row) {
      throw new PersistenceError(
        `Failed to insert environment version ${version.id}`,
        "ENVIRONMENT_VERSION_CREATE_FAILED",
      );
    }
    return environmentVersionFromRow(row);
  }

  async listActiveStepKeysUsing(
    projectId: UuidV7,
    name: string,
    dbExecutor?: DbExecutor,
  ) {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .selectDistinct({ key: stepDefinitions.key })
      .from(stepDefinitions)
      .innerJoin(
        taskExecutionConfigs,
        eq(taskExecutionConfigs.id, stepDefinitions.taskExecutionConfigId),
      )
      .where(
        and(
          eq(stepDefinitions.projectId, projectId),
          ne(stepDefinitions.status, "archived"),
          sql`${taskExecutionConfigs.environmentJson} @> ${JSON.stringify({ kind: "named", name })}::jsonb`,
        ),
      )
      .orderBy(asc(stepDefinitions.key));
    return rows.map((row) => row.key);
  }
}

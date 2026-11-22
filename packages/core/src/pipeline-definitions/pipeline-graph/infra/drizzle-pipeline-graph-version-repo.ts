import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  pipelineGraphVersionSteps,
  pipelineGraphVersions,
} from "@scarn/core/lib/db/schema";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { PersistenceError } from "@scarn/core/lib/errors";
import type { PipelineDocument } from "@scarn/sdk/contracts/pipeline-document";
import type { PipelineGraphVersionRepo } from "../application/pipeline-graph-version-repo";
import { PipelineGraphVersionEntity } from "../domain/pipeline-graph-version-entity";

type VersionRow = typeof pipelineGraphVersions.$inferSelect;
type StepRow = typeof pipelineGraphVersionSteps.$inferSelect;

const toEntity = (
  row: VersionRow,
  stepRows: readonly StepRow[],
): PipelineGraphVersionEntity =>
  PipelineGraphVersionEntity.rehydrate({
    id: row.id as UuidV7,
    pipelineGraphId: row.pipelineGraphId as UuidV7,
    version: row.version,
    definitionJson: row.definitionJson as PipelineDocument,
    schemaVersion: row.schemaVersion,
    contentHash: row.contentHash,
    steps: stepRows
      .filter((step) => step.pipelineGraphVersionId === row.id)
      .map((step) => ({
        stepKey: step.stepKey,
        stepDefinitionId: step.stepDefinitionId as UuidV7,
      })),
    createdAt: row.createdAt,
  });

/** Loads the pinned steps for `rows` and maps them to entities, in row order. */
export const loadPipelineGraphVersions = async (
  rows: readonly VersionRow[],
  db: DbExecutor,
): Promise<PipelineGraphVersionEntity[]> => {
  if (rows.length === 0) {
    return [];
  }
  const stepRows = await db
    .select()
    .from(pipelineGraphVersionSteps)
    .where(
      inArray(
        pipelineGraphVersionSteps.pipelineGraphVersionId,
        rows.map((row) => row.id),
      ),
    );
  return rows.map((row) => toEntity(row, stepRows));
};

export class DrizzlePipelineGraphVersionRepo implements PipelineGraphVersionRepo {
  async load(
    id: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<PipelineGraphVersionEntity | null> {
    const [version] = await this.loadMany([id], dbExecutor);
    return version ?? null;
  }

  async loadMany(
    ids: readonly UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<PipelineGraphVersionEntity[]> {
    if (ids.length === 0) {
      return [];
    }
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(pipelineGraphVersions)
      .where(inArray(pipelineGraphVersions.id, [...ids]));
    return await loadPipelineGraphVersions(rows, db);
  }

  async loadByNumber(
    pipelineGraphId: UuidV7,
    version: number,
    dbExecutor?: DbExecutor,
  ): Promise<PipelineGraphVersionEntity | null> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(pipelineGraphVersions)
      .where(
        and(
          eq(pipelineGraphVersions.pipelineGraphId, pipelineGraphId),
          eq(pipelineGraphVersions.version, version),
        ),
      )
      .limit(1);
    const [entity] = await loadPipelineGraphVersions(rows, db);
    return entity ?? null;
  }

  async loadLatestByGraphId(
    pipelineGraphId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<PipelineGraphVersionEntity | null> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(pipelineGraphVersions)
      .where(eq(pipelineGraphVersions.pipelineGraphId, pipelineGraphId))
      .orderBy(desc(pipelineGraphVersions.version))
      .limit(1);
    const [entity] = await loadPipelineGraphVersions(rows, db);
    return entity ?? null;
  }

  async listByGraphId(
    pipelineGraphId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<PipelineGraphVersionEntity[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(pipelineGraphVersions)
      .where(eq(pipelineGraphVersions.pipelineGraphId, pipelineGraphId))
      .orderBy(desc(pipelineGraphVersions.version));
    return await loadPipelineGraphVersions(rows, db);
  }

  async insert(
    version: PipelineGraphVersionEntity,
    dbExecutor?: DbExecutor,
  ): Promise<PipelineGraphVersionEntity> {
    const db = dbExecutor ?? getDb();
    await db.insert(pipelineGraphVersions).values({
      id: version.id,
      pipelineGraphId: version.pipelineGraphId,
      version: version.version,
      definitionJson: version.definitionJson,
      schemaVersion: version.schemaVersion,
      contentHash: version.contentHash,
      createdAt: version.createdAt ?? new Date(),
    });
    if (version.steps.length > 0) {
      await db.insert(pipelineGraphVersionSteps).values(
        version.steps.map((step) => ({
          pipelineGraphVersionId: version.id,
          stepKey: step.stepKey,
          stepDefinitionId: step.stepDefinitionId,
        })),
      );
    }
    const inserted = await this.load(version.id, db);
    if (!inserted) {
      throw new PersistenceError(
        `Failed to insert pipeline graph version ${version.id}`,
        "PIPELINE_GRAPH_VERSION_INSERT_FAILED",
      );
    }
    return inserted;
  }
}

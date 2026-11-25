import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  pipelineGraphVersionSteps,
  pipelineGraphVersions,
} from "@scarn/core/lib/db/schema";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  readRowsSkippingUnreadable,
  type StoredReadResult,
} from "@scarn/core/lib/db/stored-json";
import { PersistenceError } from "@scarn/core/lib/errors";
import { noopLogger, type Logger } from "@scarn/observability/logging";
import type { PipelineGraphVersionRepo } from "../application/pipeline-graph-version-repo";
import { readStoredPipelineDocument } from "../contracts/pipeline-graph-version-stored";
import {
  PipelineGraphVersionEntity,
  type PinnedStep,
} from "../domain/pipeline-graph-version-entity";

type VersionRow = typeof pipelineGraphVersions.$inferSelect;
type StepRow = typeof pipelineGraphVersionSteps.$inferSelect;

const readVersionRow = (
  row: VersionRow,
  steps: readonly PinnedStep[],
): StoredReadResult<PipelineGraphVersionEntity> => {
  const read = readStoredPipelineDocument(row.schemaVersion, row);
  if (!read.success) {
    return read;
  }
  return {
    success: true,
    value: PipelineGraphVersionEntity.rehydrate({
      id: row.id as UuidV7,
      pipelineGraphId: row.pipelineGraphId as UuidV7,
      version: row.version,
      definitionJson: read.value,
      schemaVersion: row.schemaVersion,
      contentHash: row.contentHash,
      steps,
      createdAt: row.createdAt,
    }),
  };
};

const pinnedStepsOf = (
  row: VersionRow,
  stepRows: readonly StepRow[],
): PinnedStep[] =>
  stepRows
    .filter((step) => step.pipelineGraphVersionId === row.id)
    .map((step) => ({
      stepKey: step.stepKey,
      stepDefinitionId: step.stepDefinitionId as UuidV7,
    }));

const loadStepRows = async (
  rows: readonly VersionRow[],
  db: DbExecutor,
): Promise<StepRow[]> =>
  rows.length === 0
    ? []
    : await db
        .select()
        .from(pipelineGraphVersionSteps)
        .where(
          inArray(
            pipelineGraphVersionSteps.pipelineGraphVersionId,
            rows.map((row) => row.id),
          ),
        );

/** A row that does not parse is a persistence fault: this code wrote it. */
export const pipelineGraphVersionFromRow = (
  row: VersionRow,
  steps: readonly PinnedStep[] = [],
): PipelineGraphVersionEntity => {
  const read = readVersionRow(row, steps);
  if (!read.success) {
    throw new PersistenceError(
      `pipeline graph version ${row.id} is unreadable: ${read.reason}`,
      "PIPELINE_GRAPH_VERSION_ROW_UNREADABLE",
    );
  }
  return read.value;
};

/**
 * Loads the pinned steps for `rows` and maps them to entities, in row order.
 * An unreadable version is logged and left out, so one bad row doesn't stop
 * the others from loading.
 */
export const loadPipelineGraphVersions = async (
  rows: readonly VersionRow[],
  db: DbExecutor,
  logger: Logger,
): Promise<PipelineGraphVersionEntity[]> => {
  const stepRows = await loadStepRows(rows, db);
  return readRowsSkippingUnreadable(
    rows,
    (row) => readVersionRow(row, pinnedStepsOf(row, stepRows)),
    logger,
    (row) => ({
      table: "pipeline_graph_versions",
      pipelineGraphId: row.pipelineGraphId,
      pipelineGraphVersionId: row.id,
    }),
  );
};

/** Maps the one row of a single-version read; an unreadable row throws. */
const loadOne = async (
  rows: readonly VersionRow[],
  db: DbExecutor,
): Promise<PipelineGraphVersionEntity | null> => {
  const [row] = rows;
  if (!row) {
    return null;
  }
  const stepRows = await loadStepRows([row], db);
  return pipelineGraphVersionFromRow(row, pinnedStepsOf(row, stepRows));
};

export class DrizzlePipelineGraphVersionRepo implements PipelineGraphVersionRepo {
  constructor(private readonly logger: Logger = noopLogger) {}

  async load(
    id: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<PipelineGraphVersionEntity | null> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(pipelineGraphVersions)
      .where(eq(pipelineGraphVersions.id, id))
      .limit(1);
    return await loadOne(rows, db);
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
    return await loadPipelineGraphVersions(rows, db, this.logger);
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
    return await loadOne(rows, db);
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
    return await loadOne(rows, db);
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
    return await loadPipelineGraphVersions(rows, db, this.logger);
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

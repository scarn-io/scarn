import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  pipelineGraphVersions,
  pipelineGraphVersionSteps,
  pipelineGraphs,
} from "@scarn/core/lib/db/schema";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { PersistenceError } from "@scarn/core/lib/errors";
import type {
  PipelineGraphRepo,
  PipelineStepUse,
  ResolvedPipelineGraph,
} from "../application/pipeline-graph-repo";
import { PipelineGraphEntity } from "../domain/pipeline-graph-entity";
import type { PipelineGraphVersionEntity } from "../domain/pipeline-graph-version-entity";
import { loadPipelineGraphVersions } from "./drizzle-pipeline-graph-version-repo";

type HandleRow = typeof pipelineGraphs.$inferSelect;

const handleRowToEntity = (row: HandleRow): PipelineGraphEntity =>
  PipelineGraphEntity.rehydrate({
    id: row.id as UuidV7,
    projectId: row.projectId as UuidV7,
    key: row.key,
    name: row.name,
    currentVersionId: (row.currentVersionId as UuidV7 | null) ?? null,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

export class DrizzlePipelineGraphRepo implements PipelineGraphRepo {
  private async resolve(
    rows: readonly HandleRow[],
    db: DbExecutor,
  ): Promise<ResolvedPipelineGraph[]> {
    const currentVersionIds = rows
      .map((row) => row.currentVersionId)
      .filter((id): id is string => id !== null);
    const versionRows =
      currentVersionIds.length === 0
        ? []
        : await db
            .select()
            .from(pipelineGraphVersions)
            .where(inArray(pipelineGraphVersions.id, currentVersionIds));
    const versions = await loadPipelineGraphVersions(versionRows, db);
    const versionsById = new Map<string, PipelineGraphVersionEntity>(
      versions.map((version) => [version.id, version]),
    );
    return rows.map((row) => ({
      handle: handleRowToEntity(row),
      currentVersion: row.currentVersionId
        ? (versionsById.get(row.currentVersionId) ?? null)
        : null,
    }));
  }

  async load(
    id: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ResolvedPipelineGraph | null> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(pipelineGraphs)
      .where(eq(pipelineGraphs.id, id))
      .limit(1);
    const [resolved] = await this.resolve(rows, db);
    return resolved ?? null;
  }

  async loadHandle(
    id: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<PipelineGraphEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(pipelineGraphs)
      .where(eq(pipelineGraphs.id, id))
      .limit(1);
    return row ? handleRowToEntity(row) : null;
  }

  async lockHandle(
    id: UuidV7,
    dbExecutor: DbExecutor,
  ): Promise<PipelineGraphEntity | null> {
    const [row] = await dbExecutor
      .select()
      .from(pipelineGraphs)
      .where(eq(pipelineGraphs.id, id))
      .limit(1)
      .for("update");
    return row ? handleRowToEntity(row) : null;
  }

  async findHandleByKey(
    projectId: UuidV7,
    key: string,
    dbExecutor?: DbExecutor,
  ): Promise<PipelineGraphEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(pipelineGraphs)
      .where(
        and(
          eq(pipelineGraphs.projectId, projectId),
          eq(pipelineGraphs.key, key),
        ),
      )
      .orderBy(
        sql`${pipelineGraphs.archivedAt} IS NOT NULL`,
        desc(pipelineGraphs.archivedAt),
      )
      .limit(1);
    return row ? handleRowToEntity(row) : null;
  }

  async listByProjectId(
    projectId: UuidV7,
    options?: { includeArchived?: boolean | undefined },
    dbExecutor?: DbExecutor,
  ): Promise<ResolvedPipelineGraph[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(pipelineGraphs)
      .where(
        options?.includeArchived
          ? eq(pipelineGraphs.projectId, projectId)
          : and(
              eq(pipelineGraphs.projectId, projectId),
              isNull(pipelineGraphs.archivedAt),
            ),
      );
    return await this.resolve(rows, db);
  }

  async listCurrentByStepDefinitionIds(
    projectId: UuidV7,
    stepDefinitionIds: readonly UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<PipelineStepUse[]> {
    if (stepDefinitionIds.length === 0) {
      return [];
    }
    const db = dbExecutor ?? getDb();
    const rows = await db
      .selectDistinct({
        stepDefinitionId: pipelineGraphVersionSteps.stepDefinitionId,
        pipeline: pipelineGraphs,
      })
      .from(pipelineGraphs)
      .innerJoin(
        pipelineGraphVersionSteps,
        eq(
          pipelineGraphVersionSteps.pipelineGraphVersionId,
          pipelineGraphs.currentVersionId,
        ),
      )
      .where(
        and(
          eq(pipelineGraphs.projectId, projectId),
          isNull(pipelineGraphs.archivedAt),
          inArray(pipelineGraphVersionSteps.stepDefinitionId, [
            ...stepDefinitionIds,
          ]),
        ),
      )
      .orderBy(pipelineGraphs.key, pipelineGraphVersionSteps.stepDefinitionId);
    return rows.map((row) => ({
      stepDefinitionId: row.stepDefinitionId as UuidV7,
      pipeline: handleRowToEntity(row.pipeline),
    }));
  }

  async insertHandle(
    handle: PipelineGraphEntity,
    dbExecutor?: DbExecutor,
  ): Promise<PipelineGraphEntity> {
    const db = dbExecutor ?? getDb();
    await db.insert(pipelineGraphs).values({
      id: handle.id,
      projectId: handle.projectId,
      key: handle.key,
      name: handle.name,
      currentVersionId: handle.currentVersionId,
      archivedAt: handle.archivedAt,
      createdAt: handle.createdAt ?? new Date(),
      updatedAt: handle.updatedAt ?? new Date(),
    });
    const created = await this.loadHandle(handle.id, db);
    if (!created) {
      throw new PersistenceError(
        `Failed to insert pipeline graph ${handle.id}`,
        "PIPELINE_GRAPH_INSERT_FAILED",
      );
    }
    return created;
  }

  async updateHandle(
    handle: PipelineGraphEntity,
    dbExecutor?: DbExecutor,
  ): Promise<PipelineGraphEntity> {
    const db = dbExecutor ?? getDb();
    await db
      .update(pipelineGraphs)
      .set({
        name: handle.name,
        currentVersionId: handle.currentVersionId,
        archivedAt: handle.archivedAt,
        updatedAt: handle.updatedAt ?? new Date(),
      })
      .where(eq(pipelineGraphs.id, handle.id));
    const updated = await this.loadHandle(handle.id, db);
    if (!updated) {
      throw new PersistenceError(
        `Failed to update pipeline graph ${handle.id}`,
        "PIPELINE_GRAPH_UPDATE_FAILED",
      );
    }
    return updated;
  }
}

import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  artifactShares,
  nodeVisits,
  pipelineGraphVersions,
  pipelineRuns,
  taskArtifactBundles,
  taskArtifactResolutions,
  taskArtifacts,
  taskRuns,
} from "@scarn/core/lib/db/schema";
import type {
  CommentArtifactReader,
  RunArtifact,
  RunArtifactBundle,
  RunArtifactResolution,
} from "../application/comment-artifact-reader";

const bundleColumns = {
  bundle: taskArtifactBundles,
  activeShareId: artifactShares.id,
};

const toRunBundle = (row: {
  bundle: typeof taskArtifactBundles.$inferSelect;
  activeShareId: string | null;
}): RunArtifactBundle => ({
  id: parseUuidV7(row.bundle.id),
  name: row.bundle.name,
  fieldPath: row.bundle.fieldPath,
  status: row.bundle.status,
  createdAt: row.bundle.createdAt,
  expiredAt: row.bundle.expiredAt,
  deletedAt: row.bundle.deletedAt,
  activeShareId:
    row.activeShareId === null ? null : parseUuidV7(row.activeShareId),
});

const activeShareJoin = and(
  eq(artifactShares.bundleId, taskArtifactBundles.id),
  isNull(artifactShares.revokedAt),
);

export class DrizzleCommentArtifactReader implements CommentArtifactReader {
  async findLatestStepArtifact(
    input: { pipelineRunId: UuidV7; stepKey: string; resultPath: string },
    dbExecutor?: DbExecutor,
  ): Promise<RunArtifactResolution | null> {
    const db = dbExecutor ?? getDb();
    const nodeStepKey = sql<string>`${pipelineGraphVersions.definitionJson} -> 'nodes' -> ${nodeVisits.nodeId} ->> 'step'`;
    const [row] = await db
      .select({
        artifactId: taskArtifactResolutions.artifactId,
        unavailableReason: taskArtifactResolutions.unavailableReason,
      })
      .from(nodeVisits)
      .innerJoin(pipelineRuns, eq(pipelineRuns.id, nodeVisits.pipelineRunId))
      .innerJoin(
        pipelineGraphVersions,
        eq(pipelineGraphVersions.id, pipelineRuns.pipelineGraphVersionId),
      )
      .innerJoin(taskRuns, eq(taskRuns.taskId, nodeVisits.taskId))
      .innerJoin(
        taskArtifactResolutions,
        eq(taskArtifactResolutions.taskRunId, taskRuns.id),
      )
      .where(
        and(
          eq(nodeVisits.pipelineRunId, input.pipelineRunId),
          ne(nodeVisits.status, "superseded"),
          or(
            eq(nodeVisits.nodeId, input.stepKey),
            eq(nodeStepKey, input.stepKey),
          ),
          eq(taskArtifactResolutions.resultPath, input.resultPath),
        ),
      )
      .orderBy(desc(nodeVisits.createdAt), desc(taskRuns.number))
      .limit(1);

    return row
      ? {
          artifactId:
            row.artifactId === null ? null : parseUuidV7(row.artifactId),
          unavailableReason: row.unavailableReason,
        }
      : null;
  }

  async listRunArtifacts(
    pipelineRunId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<RunArtifact[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .selectDistinct({ artifact: taskArtifacts })
      .from(nodeVisits)
      .innerJoin(taskRuns, eq(taskRuns.taskId, nodeVisits.taskId))
      .innerJoin(taskArtifacts, eq(taskArtifacts.taskRunId, taskRuns.id))
      .where(eq(nodeVisits.pipelineRunId, pipelineRunId))
      .orderBy(desc(taskArtifacts.createdAt), desc(taskArtifacts.id));

    return rows.map(({ artifact }) => ({
      id: parseUuidV7(artifact.id),
      relativeStorePath: artifact.relativeStorePath,
      contentType: artifact.contentType,
      kind: artifact.kind,
      sizeBytes: artifact.sizeBytes,
      storeRef: artifact.storeRef,
      deletedAt: artifact.deletedAt,
      createdAt: artifact.createdAt,
    }));
  }

  async findLatestStepBundle(
    input: { pipelineRunId: UuidV7; stepKey: string; fieldPath: string },
    dbExecutor?: DbExecutor,
  ): Promise<RunArtifactBundle | null> {
    const db = dbExecutor ?? getDb();
    const nodeStepKey = sql<string>`${pipelineGraphVersions.definitionJson} -> 'nodes' -> ${nodeVisits.nodeId} ->> 'step'`;
    const [row] = await db
      .select(bundleColumns)
      .from(nodeVisits)
      .innerJoin(pipelineRuns, eq(pipelineRuns.id, nodeVisits.pipelineRunId))
      .innerJoin(
        pipelineGraphVersions,
        eq(pipelineGraphVersions.id, pipelineRuns.pipelineGraphVersionId),
      )
      .innerJoin(taskRuns, eq(taskRuns.taskId, nodeVisits.taskId))
      .innerJoin(
        taskArtifactBundles,
        eq(taskArtifactBundles.taskRunId, taskRuns.id),
      )
      .leftJoin(artifactShares, activeShareJoin)
      .where(
        and(
          eq(nodeVisits.pipelineRunId, input.pipelineRunId),
          ne(nodeVisits.status, "superseded"),
          or(
            eq(nodeVisits.nodeId, input.stepKey),
            eq(nodeStepKey, input.stepKey),
          ),
          eq(taskArtifactBundles.fieldPath, input.fieldPath),
        ),
      )
      .orderBy(
        desc(nodeVisits.createdAt),
        desc(taskRuns.number),
        desc(taskArtifactBundles.createdAt),
      )
      .limit(1);

    return row ? toRunBundle(row) : null;
  }

  async listRunBundles(
    pipelineRunId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<RunArtifactBundle[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .selectDistinct(bundleColumns)
      .from(nodeVisits)
      .innerJoin(taskRuns, eq(taskRuns.taskId, nodeVisits.taskId))
      .innerJoin(
        taskArtifactBundles,
        eq(taskArtifactBundles.taskRunId, taskRuns.id),
      )
      .leftJoin(artifactShares, activeShareJoin)
      .where(eq(nodeVisits.pipelineRunId, pipelineRunId))
      .orderBy(
        desc(taskArtifactBundles.createdAt),
        desc(taskArtifactBundles.id),
      );

    return rows.map(toRunBundle);
  }
}

import { and, desc, eq, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { projectInOrg } from "@scarn/core/lib/db/project-in-org";
import { nodeVisits, taskArtifacts, taskRuns } from "@scarn/core/lib/db/schema";
import { PersistenceError } from "@scarn/core/lib/errors";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type {
  ArtifactContract,
  ArtifactKind,
} from "../contracts/task-artifact-contracts";
import type {
  ArtifactRepo,
  ArtifactWithRunContext,
  RecordArtifactRow,
} from "../application/artifact-repo";

const toContract = (
  row: typeof taskArtifacts.$inferSelect,
): ArtifactContract => ({
  id: row.id as ArtifactContract["id"],
  taskRunId: row.taskRunId as ArtifactContract["taskRunId"],
  projectId: row.projectId as ArtifactContract["projectId"],
  relativeStorePath: row.relativeStorePath,
  storeRef: row.storeRef,
  objectKey: row.objectKey,
  sizeBytes: row.sizeBytes,
  contentType: row.contentType,
  kind: row.kind as ArtifactKind,
  createdAt: row.createdAt.toISOString(),
});

export class DrizzleArtifactRepo implements ArtifactRepo {
  async record(
    input: RecordArtifactRow,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactContract> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .insert(taskArtifacts)
      .values({
        id: input.id,
        taskRunId: input.taskRunId,
        projectId: input.projectId,
        relativeStorePath: input.relativeStorePath,
        objectKey: input.objectKey,
        storeRef: input.storeRef,
        sizeBytes: input.sizeBytes,
        contentType: input.contentType,
        kind: input.kind,
      })
      .returning();

    if (!row) {
      throw new PersistenceError(
        `Failed to record task artifact ${input.id}`,
        "TASK_ARTIFACT_CREATE_FAILED",
      );
    }

    return toContract(row);
  }

  async listByTask(
    taskRunId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactContract[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(taskArtifacts)
      .where(
        and(
          eq(taskArtifacts.taskRunId, taskRunId),
          isNull(taskArtifacts.deletedAt),
        ),
      )
      .orderBy(desc(taskArtifacts.createdAt));

    return rows.map(toContract);
  }

  async findById(
    artifactId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactContract | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(taskArtifacts)
      .where(
        and(eq(taskArtifacts.id, artifactId), isNull(taskArtifacts.deletedAt)),
      )
      .limit(1);

    return row ? toContract(row) : null;
  }

  async findWithRunContextById(
    artifactId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactWithRunContext | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select({
        artifact: taskArtifacts,
        nodeKey: nodeVisits.nodeId,
        pipelineRunId: nodeVisits.pipelineRunId,
        attemptNumber: taskRuns.number,
      })
      .from(taskArtifacts)
      .leftJoin(taskRuns, eq(taskRuns.id, taskArtifacts.taskRunId))
      .leftJoin(nodeVisits, eq(nodeVisits.taskId, taskRuns.taskId))
      .where(eq(taskArtifacts.id, artifactId))
      .limit(1);

    if (!row) {
      return null;
    }

    return {
      ...toContract(row.artifact),
      deletedAt: row.artifact.deletedAt?.toISOString() ?? null,
      pipelineRunId: (row.pipelineRunId as UuidV7 | null) ?? null,
      attemptNumber: row.pipelineRunId === null ? null : row.attemptNumber,
      nodeKey: row.nodeKey ?? null,
    };
  }

  async listByProjectId(
    projectId: UuidV7,
    limit: number,
    dbExecutor?: DbExecutor,
  ): Promise<Array<ArtifactContract & { nodeKey: string | null }>> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select({
        artifact: taskArtifacts,
        nodeKey: nodeVisits.nodeId,
      })
      .from(taskArtifacts)
      .leftJoin(taskRuns, eq(taskRuns.id, taskArtifacts.taskRunId))
      .leftJoin(nodeVisits, eq(nodeVisits.taskId, taskRuns.taskId))
      .where(
        and(
          eq(taskArtifacts.projectId, projectId),
          isNull(taskArtifacts.deletedAt),
        ),
      )
      .orderBy(desc(taskArtifacts.createdAt))
      .limit(limit + 1);

    return rows.map((row) => ({
      ...toContract(row.artifact),
      nodeKey: row.nodeKey ?? null,
    }));
  }

  async findManyByIds(
    artifactIds: UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactContract[]> {
    if (artifactIds.length === 0) {
      return [];
    }

    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(taskArtifacts)
      .where(inArray(taskArtifacts.id, artifactIds));

    return rows.map(toContract);
  }

  async softDeleteMany(
    artifactIds: UuidV7[],
    deletedAt: Date,
    dbExecutor?: DbExecutor,
  ): Promise<UuidV7[]> {
    if (artifactIds.length === 0) {
      return [];
    }

    const db = dbExecutor ?? getDb();
    const rows = await db
      .update(taskArtifacts)
      .set({
        deletedAt,
        objectKey: null,
        storeRef: null,
        sizeBytes: null,
        contentType: null,
      })
      .where(
        and(
          inArray(taskArtifacts.id, artifactIds),
          isNull(taskArtifacts.deletedAt),
        ),
      )
      .returning({ id: taskArtifacts.id });

    return rows.map((row) => row.id as UuidV7);
  }

  async clearExpiredArtifacts(
    now: Date,
    retentionDays: number,
    dbExecutor?: DbExecutor,
    orgId?: UuidV7,
  ): Promise<number> {
    const db = dbExecutor ?? getDb();
    const cutoff = new Date(
      now.getTime() - retentionDays * 24 * 60 * 60 * 1_000,
    );

    // `createdAt` is the aging anchor (always set, never null — unlike
    // `taskRuns.logArchivedAt`), so only rows with a non-null store ref
    // strictly older than the cutoff are expired.
    const cleared = await db
      .update(taskArtifacts)
      .set({
        objectKey: null,
        storeRef: null,
        sizeBytes: null,
        contentType: null,
      })
      .where(
        and(
          isNotNull(taskArtifacts.storeRef),
          lte(taskArtifacts.createdAt, cutoff),
          projectInOrg(taskArtifacts.projectId, orgId),
        ),
      )
      .returning({ id: taskArtifacts.id });

    return cleared.length;
  }
}

import { and, desc, eq, lt } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { projectInOrg } from "@scarn/core/lib/db/project-in-org";
import { taskArtifactFailures } from "@scarn/core/lib/db/schema";
import { PersistenceError } from "@scarn/core/lib/errors";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { ArtifactKind } from "../contracts/task-artifact-contracts";
import type { ArtifactFailureContract } from "../contracts/task-artifact-failure-contracts";
import type {
  ArtifactFailureRepo,
  RecordArtifactFailureRow,
} from "../application/artifact-failure-repo";

const toContract = (
  row: typeof taskArtifactFailures.$inferSelect,
): ArtifactFailureContract => ({
  id: row.id as ArtifactFailureContract["id"],
  taskRunId: row.taskRunId as ArtifactFailureContract["taskRunId"],
  relativeStorePath: row.relativeStorePath,
  attemptedSizeBytes: row.attemptedSizeBytes,
  kind: row.kind as ArtifactKind,
  errorCode: row.errorCode,
  errorMessage: row.errorMessage,
  httpStatus: row.httpStatus,
  createdAt: row.createdAt.toISOString(),
});

export class DrizzleArtifactFailureRepo implements ArtifactFailureRepo {
  async record(
    input: RecordArtifactFailureRow,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactFailureContract> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .insert(taskArtifactFailures)
      .values({
        id: input.id,
        taskRunId: input.taskRunId,
        projectId: input.projectId,
        relativeStorePath: input.relativeStorePath,
        attemptedSizeBytes: input.attemptedSizeBytes,
        kind: input.kind,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        httpStatus: input.httpStatus,
      })
      .returning();

    if (!row) {
      throw new PersistenceError(
        `Failed to record task artifact failure ${input.id}`,
        "TASK_ARTIFACT_FAILURE_CREATE_FAILED",
      );
    }

    return toContract(row);
  }

  async listByTask(
    taskRunId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactFailureContract[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(taskArtifactFailures)
      .where(eq(taskArtifactFailures.taskRunId, taskRunId))
      .orderBy(desc(taskArtifactFailures.createdAt));

    return rows.map(toContract);
  }

  async deleteExpiredFailures(
    now: Date,
    retentionDays: number,
    dbExecutor?: DbExecutor,
    orgId?: UuidV7,
  ): Promise<number> {
    const db = dbExecutor ?? getDb();
    const cutoff = new Date(
      now.getTime() - retentionDays * 24 * 60 * 60 * 1_000,
    );

    // Hard delete: failure rows carry no bytes, so there is nothing to null
    // out — unlike `clearExpiredArtifacts`, expiry removes the row outright.
    const deleted = await db
      .delete(taskArtifactFailures)
      .where(
        and(
          lt(taskArtifactFailures.createdAt, cutoff),
          projectInOrg(taskArtifactFailures.projectId, orgId),
        ),
      )
      .returning({ id: taskArtifactFailures.id });

    return deleted.length;
  }
}

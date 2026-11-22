import { asc, eq } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { taskArtifactResolutions } from "@scarn/core/lib/db/schema";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type {
  TaskArtifactResolution,
  TaskArtifactResolutionRepo,
} from "../application/task-artifact-resolution-repo";

export class DrizzleTaskArtifactResolutionRepo implements TaskArtifactResolutionRepo {
  async replaceForTask(
    taskRunId: UuidV7,
    resolutions: TaskArtifactResolution[],
    dbExecutor?: DbExecutor,
  ): Promise<void> {
    const db = dbExecutor ?? getDb();
    await db
      .delete(taskArtifactResolutions)
      .where(eq(taskArtifactResolutions.taskRunId, taskRunId));
    if (resolutions.length === 0) {
      return;
    }
    await db.insert(taskArtifactResolutions).values(
      resolutions.map((resolution) => ({
        taskRunId: resolution.taskRunId,
        resultPath: resolution.resultPath,
        artifactId: resolution.artifactId,
        unavailableReason: resolution.unavailableReason,
      })),
    );
  }

  async listByTask(
    taskRunId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<TaskArtifactResolution[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(taskArtifactResolutions)
      .where(eq(taskArtifactResolutions.taskRunId, taskRunId))
      .orderBy(asc(taskArtifactResolutions.resultPath));
    return rows.map((row) => ({
      taskRunId: row.taskRunId as UuidV7,
      resultPath: row.resultPath,
      artifactId: row.artifactId as UuidV7 | null,
      unavailableReason: row.unavailableReason,
    }));
  }
}

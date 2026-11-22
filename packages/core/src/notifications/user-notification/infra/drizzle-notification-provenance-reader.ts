import { eq } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { nodeVisits, taskRuns } from "@scarn/core/lib/db/schema";
import type {
  NotificationProvenance,
  NotificationProvenanceReader,
} from "../application/notification-provenance-reader";

export class DrizzleNotificationProvenanceReader implements NotificationProvenanceReader {
  async resolveFromTaskRun(
    taskRunId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<NotificationProvenance | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select({
        projectId: taskRuns.projectId,
        taskId: taskRuns.taskId,
        workItemId: taskRuns.workItemId,
        pipelineRunId: nodeVisits.pipelineRunId,
      })
      .from(taskRuns)
      .leftJoin(nodeVisits, eq(nodeVisits.taskId, taskRuns.taskId))
      .where(eq(taskRuns.id, taskRunId))
      .limit(1);

    if (!row) return null;

    return {
      projectId: parseUuidV7(row.projectId),
      taskId: parseUuidV7(row.taskId),
      workItemId:
        row.workItemId === null ? null : parseUuidV7(row.workItemId),
      pipelineExecutionId:
        row.pipelineRunId === null ? null : parseUuidV7(row.pipelineRunId),
    };
  }
}

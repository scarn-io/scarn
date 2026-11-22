import { eq, inArray } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { stepDefinitions, tasks } from "@scarn/core/lib/db/schema";
import {
  UNNAMED_AUTHOR_TASK_LABEL,
  type CommentTaskNameReader,
} from "../application/comment-task-name-reader";

export class DrizzleCommentTaskNameReader implements CommentTaskNameReader {
  async loadTaskNamesByTaskId(
    taskIds: readonly UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<Map<UuidV7, string>> {
    const uniqueIds = [...new Set(taskIds)];
    if (uniqueIds.length === 0) {
      return new Map<UuidV7, string>();
    }

    const db = dbExecutor ?? getDb();
    const rows = await db
      .select({
        id: tasks.id,
        name: tasks.name,
        stepName: stepDefinitions.name,
      })
      .from(tasks)
      .leftJoin(stepDefinitions, eq(stepDefinitions.id, tasks.stepDefinitionId))
      .where(inArray(tasks.id, uniqueIds));

    return new Map(
      rows.map((row) => [
        row.id as UuidV7,
        row.name?.trim() || row.stepName?.trim() || UNNAMED_AUTHOR_TASK_LABEL,
      ]),
    );
  }
}

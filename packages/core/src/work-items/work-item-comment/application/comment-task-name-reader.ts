import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";

/** Shown for an authoring Task with no name of its own or of its step. */
export const UNNAMED_AUTHOR_TASK_LABEL = "Agent";

/**
 * Read-time resolver from the Tasks that authored comments
 * (`authoredByTaskId`) to the name shown as the comment's author: the Task's
 * name, else its step definition's, else `UNNAMED_AUTHOR_TASK_LABEL`. The
 * name is never persisted on the comment, so it can't go stale.
 */
export type CommentTaskNameReader = {
  /**
   * Batch-resolve Task ids to display names. Ids with no Task are omitted.
   * De-duplicates ids before querying.
   */
  loadTaskNamesByTaskId(
    taskIds: readonly UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<Map<UuidV7, string>>;
};

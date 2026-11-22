import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { UserNotificationRepo } from "@scarn/core/notifications/user-notification/application/user-notification-repo";
import {
  deleteRunStorage,
  type DeleteRunStorageDeps,
} from "@scarn/core/tasks/storage-sweep/application/delete-run-storage";
import {
  scheduleStorageSweeps,
  type ScheduleStorageSweepsDeps,
} from "@scarn/core/tasks/storage-sweep/application/schedule-storage-sweeps";
import type { SweptRun } from "@scarn/core/tasks/storage-sweep/domain/storage-sweep";
import {
  releaseTaskRunSessions,
  type TaskRunSessionsDeps,
} from "@scarn/core/tasks/task-run/application/task-run-sessions";
import type { TaskRepo } from "@scarn/core/tasks/task/application/task-repo";
import { conversationIdParamsSchema } from "../contracts/conversation-contracts";
import type { ConversationRepo } from "./conversation-repo";
import {
  lockRepoConversation,
  type LockRepoConversationDeps,
} from "./lock-repo-conversation";

export type DeleteRepoConversationDeps = Omit<
  LockRepoConversationDeps,
  "taskRepo" | "taskRunRepo" | "conversationRepo"
> &
  ScheduleStorageSweepsDeps &
  Omit<TaskRunSessionsDeps, "taskRunRepo"> & {
    taskRepo: LockRepoConversationDeps["taskRepo"] &
      Pick<TaskRepo, "deleteMany">;
    taskRunRepo: LockRepoConversationDeps["taskRunRepo"] &
      TaskRunSessionsDeps["taskRunRepo"];
    conversationRepo: Pick<ConversationRepo, "lock" | "delete">;
    userNotificationRepo: Pick<
      UserNotificationRepo,
      "deleteByTaskOrConversation"
    >;
    objectStore: DeleteRunStorageDeps["objectStore"];
    dbExecutor?: DbExecutor | undefined;
  };

/**
 * A person deletes a chat, in any state, in one transaction (see
 * docs/adr/0003-conversation-deletion-contract.md): a storage sweep per run,
 * its saved sessions taken off the meter, its notifications, its Task (with
 * runs, log lines, agent sessions, artifact records and task messages, by
 * cascade) and its conversation (with messages, by cascade). After commit
 * the runs' stored objects are deleted best-effort; the sweeps delete them
 * again once late uploads can no longer land. A worker still holding a
 * claim then finds no run (404). Same permission and locks as End; 404 when
 * the conversation isn't a chat.
 */
export const deleteRepoConversation = async (
  input: { conversationId: string },
  deps: DeleteRepoConversationDeps,
): Promise<Result<{ conversationId: UuidV7 }, ResourceNotFoundError>> => {
  const { conversationId } = conversationIdParamsSchema.parse(input);
  const db = deps.dbExecutor ?? getDb();
  const deleted = await db.transaction(async (tx) => {
    const locked = await lockRepoConversation(conversationId, deps, tx);
    if (!locked) {
      return null;
    }
    const { task, runs } = locked;
    const swept: SweptRun[] = runs.map((run) => ({
      projectId: run.projectId,
      taskRunId: run.id,
    }));
    await scheduleStorageSweeps(swept, deps, tx);
    await releaseTaskRunSessions(runs, deps, tx);
    await deps.userNotificationRepo.deleteByTaskOrConversation(
      { projectId: task.projectId, taskId: task.id, conversationId },
      tx,
    );
    await deps.taskRepo.deleteMany([task.id], tx);
    await deps.conversationRepo.delete(conversationId, tx);
    return swept;
  });
  if (deleted === null) {
    return Result.err(
      new ResourceNotFoundError("Conversation", conversationId),
    );
  }
  await deleteRunStorage(deleted, deps);
  return Result.ok({ conversationId });
};

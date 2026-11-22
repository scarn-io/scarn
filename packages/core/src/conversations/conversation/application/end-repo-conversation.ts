import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import {
  withTaskSessionCleanup,
  type SessionCleanupDeps,
} from "@scarn/core/tasks/task-run/application/delete-task-sessions";
import { releaseTaskRunSessions } from "@scarn/core/tasks/task-run/application/task-run-sessions";
import {
  cancelStandalone,
  type CancelStandaloneDeps,
} from "@scarn/core/tasks/task/application/cancel-task";
import { isTaskEnded } from "@scarn/core/tasks/task/application/on-task-ended";
import { conversationIdParamsSchema } from "../contracts/conversation-contracts";
import {
  lockRepoConversation,
  type LockRepoConversationDeps,
} from "./lock-repo-conversation";

export type EndRepoConversationDeps = CancelStandaloneDeps &
  SessionCleanupDeps &
  Omit<LockRepoConversationDeps, "taskRunRepo" | "conversationRepo"> & {
    taskRunRepo: CancelStandaloneDeps["taskRunRepo"] &
      LockRepoConversationDeps["taskRunRepo"];
    dbExecutor?: DbExecutor | undefined;
  };

/**
 * A person ends a chat (End): its conversation closes, and a Task still
 * queued, running or waiting is cancelled, revoking its run's claim. Its
 * saved sessions are released and deleted after commit. The transcript
 * stays readable; nothing else is written (no system message). Allowed from
 * queued, running, waiting or failed; ending an ended chat does nothing. Needs
 * `assertCanManageConversation`; 404 when the conversation isn't a chat.
 */
export const endRepoConversation = async (
  input: { conversationId: string },
  deps: EndRepoConversationDeps,
): Promise<Result<{ conversationId: UuidV7 }, ResourceNotFoundError>> => {
  const { conversationId } = conversationIdParamsSchema.parse(input);
  const db = deps.dbExecutor ?? getDb();
  return await withTaskSessionCleanup(deps, (endedTaskSessions) =>
    db.transaction(async (tx) => {
      const locked = await lockRepoConversation(conversationId, deps, tx);
      if (!locked) {
        return Result.err(
          new ResourceNotFoundError("Conversation", conversationId),
        );
      }
      const { task, conversation } = locked;
      if (conversation.isClosed) {
        return Result.ok({ conversationId });
      }
      const now = deps.timeProvider.now();
      await deps.conversationRepo.save(conversation.close(now), tx);
      if (!isTaskEnded(task)) {
        await cancelStandalone(task, { ...deps, endedTaskSessions }, tx);
      }
      await releaseTaskRunSessions(
        await deps.taskRunRepo.listByTaskId(task.id, tx),
        { ...deps, endedTaskSessions },
        tx,
      );
      return Result.ok({ conversationId });
    }),
  );
};

import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { ProjectRepo } from "@scarn/core/projects/project/application/project-repo";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import type { TaskRunEntity } from "@scarn/core/tasks/task-run/domain/task-run-entity";
import type { TaskRepo } from "@scarn/core/tasks/task/application/task-repo";
import type { TaskEntity } from "@scarn/core/tasks/task/domain/task-entity";
import type { ConversationEntity } from "../domain/conversation-entity";
import { assertCanManageConversation } from "./conversation-capabilities";
import type { ConversationRepo } from "./conversation-repo";

export type LockRepoConversationDeps = {
  userAuthz: UserAuthorizationService;
  projectRepo: Pick<ProjectRepo, "load">;
  taskRepo: Pick<TaskRepo, "lockByConversationId">;
  taskRunRepo: Pick<TaskRunRepo, "lockByConversationId">;
  conversationRepo: Pick<ConversationRepo, "lock">;
};

export type LockedRepoConversation = {
  task: TaskEntity;
  /** Every run of the chat's Task, oldest first. */
  runs: TaskRunEntity[];
  conversation: ConversationEntity;
};

/**
 * Locks a chat for End or Delete and checks the caller may manage it
 * (`assertCanManageConversation`). Null when `conversationId` isn't a chat:
 * no such conversation, or one a work-item Task owns. Takes the runs, then
 * the Task, then the conversation: the order a worker's claim, yield or
 * completion takes them in. The runs are locked again once the Task is held,
 * to catch one a reply queued in between.
 */
export const lockRepoConversation = async (
  conversationId: UuidV7,
  deps: LockRepoConversationDeps,
  tx: DbExecutor,
): Promise<LockedRepoConversation | null> => {
  await deps.taskRunRepo.lockByConversationId(conversationId, tx);
  const task = await deps.taskRepo.lockByConversationId(conversationId, tx);
  if (task?.workItemId !== null) {
    return null;
  }
  const conversation = await deps.conversationRepo.lock(conversationId, tx);
  const project = await deps.projectRepo.load(task.projectId, tx);
  if (!conversation || conversation.workItemId !== null || !project) {
    return null;
  }
  assertCanManageConversation(
    project,
    task.startedByUserId,
    deps.userAuthz.actorId,
  );
  return {
    task,
    runs: await deps.taskRunRepo.lockByConversationId(conversationId, tx),
    conversation,
  };
};

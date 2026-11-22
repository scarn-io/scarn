import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { ConversationRepo } from "@scarn/core/conversations/conversation/application/conversation-repo";
import { ConversationEndedError } from "@scarn/core/conversations/conversation/domain/conversation-entity";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  CoreValidationError,
  InvariantViolationError,
  ResourceNotFoundError,
} from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import type { WorkItemBlockRepo } from "@scarn/core/work-items/work-item-block/application/work-item-block-repo";
import {
  retryTaskInputSchema,
  type RetryTaskInput,
  type RetriedTaskContract,
} from "../contracts/task-contracts";
import {
  assertTaskRetryable,
  retryTaskAttempt,
  taskForRetry,
} from "../domain/retry-task-attempt";
import type { TaskGroup } from "./task-group";
import type { TaskPipelineRunPort } from "./task-pipeline-run-port";
import type { TaskRepo } from "./task-repo";

export type RetryTaskDeps = {
  userAuthz: UserAuthorizationService;
  taskRepo: TaskRepo;
  taskRunRepo: Pick<TaskRunRepo, "listByTaskId" | "create">;
  conversationRepo: Pick<ConversationRepo, "lock" | "save">;
  taskPipelineRun: Pick<TaskPipelineRunPort, "findForTask">;
  taskGroup: Pick<TaskGroup, "reacquire">;
  workItemBlockRepo: Pick<WorkItemBlockRepo, "listIdsWithOpenBlockers">;
  timeProvider: TimeProvider;
  dbExecutor?: DbExecutor | undefined;
};

/**
 * A person's retry of an ended standalone Task, atomically reacquiring its
 * slot. A chat (no work item) whose conversation is closed has ended and is
 * refused with 409 `CONVERSATION_ENDED`; a failed chat's conversation stays
 * open, so it can be retried. The retry writes no conversation message.
 */
export const retryTask = async (
  input: RetryTaskInput,
  deps: RetryTaskDeps,
): Promise<Result<RetriedTaskContract, ResourceNotFoundError>> => {
  const { taskId, expectedLatestRunId } = retryTaskInputSchema.parse(input);
  const db = deps.dbExecutor ?? getDb();
  return await db.transaction(async (tx) => {
    const task = await deps.taskRepo.lock(taskId, tx);
    if (!task) {
      return Result.err(new ResourceNotFoundError("Task", taskId));
    }
    await deps.userAuthz.requireProjectPermission({
      projectId: task.projectId,
      permission: "executions:write",
      dbExecutor: tx,
    });
    if (await deps.taskPipelineRun.findForTask(task.id, tx)) {
      throw new CoreValidationError(
        "Pipeline-owned Tasks cannot be retried directly; rerun the pipeline instead",
        "TASK_RETRY_PIPELINE_OWNED",
      );
    }
    const runs = await deps.taskRunRepo.listByTaskId(task.id, tx);
    const latest = [...runs].sort((a, b) => b.number - a.number)[0] ?? null;
    const now = deps.timeProvider.now();
    assertTaskRetryable(
      taskForRetry(task, latest, now),
      latest,
      expectedLatestRunId,
    );
    await deps.taskGroup.reacquire(task, tx);
    const blocked =
      runs.length === 0 &&
      task.workItemId !== null &&
      (
        await deps.workItemBlockRepo.listIdsWithOpenBlockers(
          [task.workItemId],
          tx,
        )
      ).length > 0;
    const retried = retryTaskAttempt(
      task,
      runs,
      expectedLatestRunId,
      blocked,
      now,
    );
    if (task.conversationId !== null) {
      const conversation = await deps.conversationRepo.lock(
        task.conversationId,
        tx,
      );
      if (!conversation) {
        throw new InvariantViolationError(
          `Conversation ${task.conversationId} of Task ${task.id} is missing`,
          "TASK_CONVERSATION_MISSING",
        );
      }
      if (task.workItemId === null && conversation.isClosed) {
        throw new ConversationEndedError(conversation.id);
      }
      await deps.conversationRepo.save(conversation.reopenForRetry(now), tx);
    }
    if (retried.run !== null) {
      await deps.taskRunRepo.create(retried.run, tx);
    }
    await deps.taskRepo.save(retried.task, tx);
    return Result.ok({ taskId: task.id, taskRunId: retried.run?.id ?? null });
  });
};

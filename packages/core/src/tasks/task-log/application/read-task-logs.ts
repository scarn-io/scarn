import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import { isTerminalTaskRunStatus } from "@scarn/core/tasks/task-run/application/task-run-status-helpers";
import {
  readTaskLogsQuerySchema,
  taskIdInputSchema,
  type ReadTaskLogsQuery,
  type ReadTaskLogsResult,
} from "../contracts/task-log-contracts";
import type { LogFeedStore } from "./log-feed-store";

/**
 * UI read path: return live feed lines after a cursor. `complete` flips true
 * once the task is terminal AND its feed has been flushed to the durable
 * archive, signalling the client to stop polling and read the archive instead.
 */
export const readTaskLogs = async (
  taskIdInput: string,
  query: ReadTaskLogsQuery,
  {
    userAuthz,
    taskRunRepo,
    logFeedStore,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    taskRunRepo: TaskRunRepo;
    logFeedStore: LogFeedStore;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<ReadTaskLogsResult, ResourceNotFoundError>> => {
  const taskRunId = taskIdInputSchema.parse(taskIdInput);
  const { from, limit } = readTaskLogsQuerySchema.parse(query);

  const task = await taskRunRepo.load(taskRunId, dbExecutor);
  if (!task) {
    return Result.err(new ResourceNotFoundError("Task", taskRunId));
  }

  await userAuthz.requireProjectPermission({
    projectId: task.projectId,
    permission: "executions:read",
  });

  const { lines, nextOffset } = await logFeedStore.read(
    taskRunId,
    from,
    limit,
    dbExecutor,
  );

  const archive = await taskRunRepo.getLogArchive(taskRunId, dbExecutor);
  const complete = isTerminalTaskRunStatus(task.status) && archive !== null;

  return Result.ok({ lines, nextOffset, complete });
};

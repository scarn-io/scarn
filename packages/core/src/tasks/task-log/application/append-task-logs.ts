import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import { assertClaimOwnership } from "@scarn/core/tasks/task-run/application/task-run-claim-helpers";
import {
  appendTaskLogsInputSchema,
  taskIdInputSchema,
  type AppendTaskLogsInput,
  type AppendTaskLogsResult,
} from "../contracts/task-log-contracts";
import type { LogFeedStore } from "./log-feed-store";

/**
 * Worker-only: append a batch of log lines for a running task. The
 * caller must hold both the project `executions:write` permission (Better Auth
 * session) and a valid claim token for the task, mirroring heartbeat auth.
 */
export const appendTaskLogs = async (
  taskIdInput: string,
  input: AppendTaskLogsInput,
  {
    userAuthz,
    taskRunRepo,
    logFeedStore,
    timeProvider,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    taskRunRepo: TaskRunRepo;
    logFeedStore: LogFeedStore;
    timeProvider: TimeProvider;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<AppendTaskLogsResult, ResourceNotFoundError>> => {
  const taskRunId = taskIdInputSchema.parse(taskIdInput);
  const parsedInput = appendTaskLogsInputSchema.parse(input);

  const task = await taskRunRepo.load(taskRunId, dbExecutor);
  if (!task) {
    return Result.err(new ResourceNotFoundError("Task", taskRunId));
  }

  await userAuthz.requireProjectPermission({
    projectId: task.projectId,
    permission: "executions:write",
  });
  assertClaimOwnership(task, parsedInput.claimToken, timeProvider.now());

  const { nextOffset } = await logFeedStore.append(
    taskRunId,
    parsedInput.lines,
    dbExecutor,
  );
  return Result.ok({ nextOffset });
};

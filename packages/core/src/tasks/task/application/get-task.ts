import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { UsernameReader } from "@scarn/core/organizations/organization/application/username-reader";
import {
  getTaskInputSchema,
  type GetTaskInput,
} from "../contracts/task-contracts";
import type { TaskDetailContract } from "../contracts/task-summary-contracts";
import type { TaskRepo } from "./task-repo";
import { taskEntityToContract } from "./task-contract-mapper";
import type { TaskSummaryReader } from "./task-summary-reader";
import { taskSummariesToContracts } from "./task-summary-mapper";

/**
 * A Task with its work item, source, starter and step visit. Its status is
 * the summary's, which applies the latest run's liveness clocks.
 */
export const getTask = async (
  input: GetTaskInput,
  {
    userAuthz,
    taskRepo,
    taskSummaryReader,
    usernameReader,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    taskRepo: TaskRepo;
    taskSummaryReader: TaskSummaryReader;
    usernameReader: UsernameReader;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<TaskDetailContract, ResourceNotFoundError>> => {
  const taskId = getTaskInputSchema.parse(input);
  const task = await taskRepo.load(taskId, dbExecutor);
  if (!task) {
    return Result.err(new ResourceNotFoundError("Task", taskId));
  }

  await userAuthz.requireProjectPermission({
    projectId: task.projectId,
    permission: "executions:read",
  });
  const record = await taskSummaryReader.loadByTaskId(task.id, dbExecutor);
  if (!record) {
    return Result.err(new ResourceNotFoundError("Task", taskId));
  }
  const [summary] = await taskSummariesToContracts(
    [record],
    userAuthz.actorId,
    usernameReader,
    dbExecutor,
  );
  if (!summary) {
    return Result.err(new ResourceNotFoundError("Task", taskId));
  }
  const {
    status,
    waitingOnYou,
    waitingOn,
    conversationId,
    workItem,
    repoConversation,
    startedBy,
    scheduledFor,
    source,
    pipelineRunId,
    nodeId,
  } = summary;
  return Result.ok({
    ...taskEntityToContract(task),
    status,
    waitingOnYou,
    waitingOn,
    conversationId,
    workItem,
    repoConversation,
    startedBy,
    scheduledFor,
    source,
    pipelineRunId,
    nodeId,
  });
};

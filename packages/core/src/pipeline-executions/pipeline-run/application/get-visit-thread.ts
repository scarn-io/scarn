import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { taskMessageEntityToContract } from "@scarn/core/tasks/task-message/application/task-message-contract-mapper";
import type { TaskRunHistoryReader } from "@scarn/core/tasks/task-run/application/task-run-history-reader";
import {
  getVisitThreadInputSchema,
  type GetVisitThreadInput,
  type VisitThreadContract,
} from "../contracts/pipeline-run-contracts";
import type { PipelineRunReadDeps } from "./pipeline-run-contract-mapper";

/**
 * A visit's conversation: its latest Task and every earlier run it follows
 * through its previous runs (including the superseded visits it replaced),
 * oldest first, each with its messages. A continuation says whether it
 * restored the session. A visit with no Task has an empty thread; agent
 * messages live in the visit's conversation.
 */
export const getVisitThread = async (
  input: GetVisitThreadInput,
  deps: Pick<
    PipelineRunReadDeps,
    "pipelineRunRepo" | "taskRunRepo" | "timeProvider" | "dbExecutor"
  > & {
    userAuthz: UserAuthorizationService;
    taskRunHistoryReader: TaskRunHistoryReader;
  },
): Promise<Result<VisitThreadContract, ResourceNotFoundError>> => {
  const parsed = getVisitThreadInputSchema.parse(input);
  const run = await deps.pipelineRunRepo.load(
    parsed.pipelineExecutionId,
    deps.dbExecutor,
  );
  if (!run) {
    return Result.err(
      new ResourceNotFoundError("Pipeline run", parsed.pipelineExecutionId),
    );
  }
  await deps.userAuthz.requireProjectPermission({
    projectId: run.projectId,
    permission: "executions:read",
    dbExecutor: deps.dbExecutor,
  });
  const history = await deps.pipelineRunRepo.loadHistory(
    run.id,
    deps.dbExecutor,
  );
  const visit = history.visits.find((item) => item.id === parsed.visitId);
  if (!visit) {
    return Result.err(new ResourceNotFoundError("Node visit", parsed.visitId));
  }
  const latest = history.visitTasks
    .filter((link) => link.visitId === visit.id)
    .sort((left, right) => left.attemptNumber - right.attemptNumber)
    .at(-1);
  const runs = latest
    ? await deps.taskRunHistoryReader.loadHistory(
        latest.taskId as typeof run.id,
        deps.timeProvider.now(),
        deps.dbExecutor,
      )
    : [];
  const tasks =
    runs.length > 0
      ? await deps.taskRunRepo.loadManyByIds(
          runs.map((item) => item.taskRunId),
          deps.dbExecutor,
        )
      : [];
  const tasksById = new Map(tasks.map((task) => [task.id as string, task]));
  return Result.ok({
    visitId: visit.id,
    nodeId: visit.nodeId,
    runs: runs.map((item) => {
      const task = tasksById.get(item.taskRunId);
      return {
        taskRunId: item.taskRunId,
        previousTaskRunId: item.previousTaskRunId,
        status: item.status,
        createdAt: item.createdAt.toISOString(),
        messages: item.messages.map(taskMessageEntityToContract),
        sessionRestored: task?.sessionRestored ?? null,
      };
    }),
  });
};

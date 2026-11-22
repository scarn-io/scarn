import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  getTaskRunInputSchema,
  reportTaskRunBaseCommitInputSchema,
  type GetTaskRunInput,
  type ReportTaskRunBaseCommitInput,
  type TaskRunBaseCommitContract,
} from "../contracts/task-run-contracts";
import { assertClaimOwnership } from "./task-run-claim-helpers";
import type { TaskRunRepo } from "./task-run-repo";

/**
 * A worker pins the commit (and, when the run has none, the branch) it
 * resolved for a run. Only the first report is stored: a later or
 * concurrent one gets the stored values back, which the worker then uses.
 * Needs the live claim, so a run that was deleted or lost its claim can't
 * be pinned.
 */
export const reportTaskRunBaseCommit = async (
  taskIdInput: GetTaskRunInput,
  input: ReportTaskRunBaseCommitInput,
  {
    userAuthz,
    taskRunRepo,
    timeProvider,
  }: {
    userAuthz: UserAuthorizationService;
    taskRunRepo: Pick<TaskRunRepo, "load" | "pinBaseCommit">;
    timeProvider: TimeProvider;
  },
): Promise<Result<TaskRunBaseCommitContract, ResourceNotFoundError>> => {
  const taskRunId = getTaskRunInputSchema.parse(taskIdInput);
  const parsed = reportTaskRunBaseCommitInputSchema.parse(input);
  const run = await taskRunRepo.load(taskRunId);
  if (!run) {
    return Result.err(new ResourceNotFoundError("Task", taskRunId));
  }
  await userAuthz.requireProjectPermission({
    projectId: run.projectId,
    permission: "executions:write",
  });
  const now = timeProvider.now();
  assertClaimOwnership(run, parsed.claimToken, now);

  const pinned = await taskRunRepo.pinBaseCommit(run.id, parsed.claimToken, {
    baseCommit: parsed.baseCommit,
    baseBranch: parsed.baseBranch ?? null,
    now,
  });
  if (!pinned) {
    return Result.err(new ResourceNotFoundError("Task", run.id));
  }
  return Result.ok(pinned);
};

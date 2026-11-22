import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  cancelPipelineExecutionsInputSchema,
  getPipelineExecutionInputSchema,
  type CancelPipelineExecutionsInput,
  type CancelPipelineExecutionsResult,
  type GetPipelineExecutionInput,
  type PipelineExecutionContract,
} from "../contracts/pipeline-run-contracts";
import type { RunCompletion } from "../domain/run-completion";
import { advancePipelineRun, type AdvanceError } from "./advance-pipeline-run";
import {
  commandPipelineRun,
  fixedEvent,
  type PipelineRunCommandDeps,
} from "./command-pipeline-run";
import { deleteTaskSessions } from "@scarn/core/tasks/task-run/application/delete-task-sessions";
import { reportRunCompletion } from "./report-run-completion";

/** Cancels the run's open Tasks, visits and lanes, and marks it cancelled. */
export const cancelPipelineRun = async (
  input: GetPipelineExecutionInput,
  deps: PipelineRunCommandDeps,
): Promise<Result<PipelineExecutionContract, AdvanceError>> => {
  const pipelineRunId = getPipelineExecutionInputSchema.parse(input);
  const outcome = await commandPipelineRun(
    pipelineRunId,
    {
      event: fixedEvent({ type: "cancel", userId: deps.userAuthz.actorId }),
    },
    deps,
  );
  return outcome.ok
    ? { ok: true, value: outcome.value.pipelineExecution }
    : outcome;
};

/**
 * Cancels several runs at once. Runs that are already finished are skipped
 * rather than failing the batch; the open check happens under each run's
 * lock so a run that finished meanwhile is skipped too.
 */
export const cancelPipelineExecutions = async (
  input: CancelPipelineExecutionsInput,
  deps: PipelineRunCommandDeps,
): Promise<Result<CancelPipelineExecutionsResult, ResourceNotFoundError>> => {
  const pipelineRunIds = cancelPipelineExecutionsInputSchema.parse(
    input,
  ) as UuidV7[];
  const runs = [];
  for (const pipelineRunId of pipelineRunIds) {
    const run = await deps.pipelineRunRepo.load(pipelineRunId, deps.dbExecutor);
    if (!run) {
      return Result.err(
        new ResourceNotFoundError("Pipeline run", pipelineRunId),
      );
    }
    runs.push(run);
  }
  for (const projectId of new Set(runs.map((run) => run.projectId))) {
    await deps.userAuthz.requireProjectPermission({
      projectId,
      permission: "executions:write",
      dbExecutor: deps.dbExecutor,
    });
  }

  const db: DbExecutor = deps.dbExecutor ?? getDb();
  const cancelledIds: UuidV7[] = [];
  const skippedIds: UuidV7[] = [];
  const completions: RunCompletion[] = [];
  const endedSessionObjectKeys: string[] = [];
  await db.transaction(async (tx) => {
    for (const pipelineRunId of pipelineRunIds) {
      const locked = await deps.pipelineRunRepo.lock(pipelineRunId, tx);
      if (!locked?.isOpen) {
        skippedIds.push(pipelineRunId);
        continue;
      }
      const advanced = Result.unwrap(
        await advancePipelineRun(
          pipelineRunId,
          { type: "cancel", userId: deps.userAuthz.actorId },
          deps,
          tx,
        ),
      );
      cancelledIds.push(pipelineRunId);
      endedSessionObjectKeys.push(...advanced.endedSessionObjectKeys);
      if (advanced.completion) {
        completions.push(advanced.completion);
      }
    }
  });
  if (!deps.dbExecutor) {
    for (const completion of completions) {
      await reportRunCompletion(completion, deps);
    }
    await deleteTaskSessions(endedSessionObjectKeys, deps);
  }
  return Result.ok({ cancelledIds, skippedIds });
};

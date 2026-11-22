import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { EngineEvent } from "../domain/engine/types";
import type { PipelineExecutionContract } from "../contracts/pipeline-run-contracts";
import type { PipelineRunEntity } from "../domain/pipeline-run-entity";
import {
  advancePipelineRun,
  type AdvanceError,
  type AdvanceOptions,
  type AdvanceOutcome,
} from "./advance-pipeline-run";
import {
  projectPipelineRunsToContracts,
  type PipelineRunReadDeps,
} from "./pipeline-run-contract-mapper";
import { deleteTaskSessions } from "@scarn/core/tasks/task-run/application/delete-task-sessions";
import { reportRunCompletion } from "./report-run-completion";
import type { TaskAndAdvanceDeps } from "./task-and-advance";

export type PipelineRunCommandDeps = TaskAndAdvanceDeps &
  PipelineRunReadDeps & {
    userAuthz: UserAuthorizationService;
  };

export type PipelineRunCommandOutcome = {
  advanced: AdvanceOutcome;
  pipelineExecution: PipelineExecutionContract;
};

export type PipelineRunCommand = {
  /** The event to advance with; an error stops before anything is written. */
  event(
    run: PipelineRunEntity,
    tx: DbExecutor,
  ): Promise<Result<EngineEvent, AdvanceError>>;
  /** Checks the advance's outcome; an error rolls the advance back. */
  verify?(outcome: AdvanceOutcome): AdvanceError | null;
  options?: AdvanceOptions;
};

class CommandRejected extends Error {
  constructor(public readonly reason: AdvanceError) {
    super(reason.message);
  }
}

/**
 * A user's command against one run: checks `executions:write` on the run's
 * project, advances the run in one transaction, reports a completion once
 * that transaction commits, and returns the run as the API shows it.
 */
export const commandPipelineRun = async (
  pipelineRunId: UuidV7,
  command: PipelineRunCommand,
  deps: PipelineRunCommandDeps,
): Promise<Result<PipelineRunCommandOutcome, AdvanceError>> => {
  const run = await deps.pipelineRunRepo.load(pipelineRunId, deps.dbExecutor);
  if (!run) {
    return Result.err(new ResourceNotFoundError("Pipeline run", pipelineRunId));
  }
  await deps.userAuthz.requireProjectPermission({
    projectId: run.projectId,
    permission: "executions:write",
    dbExecutor: deps.dbExecutor,
  });

  const db: DbExecutor = deps.dbExecutor ?? getDb();
  let advanced: Result<AdvanceOutcome, AdvanceError>;
  try {
    advanced = await db.transaction(async (tx) => {
      const event = await command.event(run, tx);
      if (!event.ok) {
        return event;
      }
      const outcome = await advancePipelineRun(
        run.id,
        event.value,
        deps,
        tx,
        command.options,
      );
      const rejected = outcome.ok ? command.verify?.(outcome.value) : null;
      if (rejected) {
        throw new CommandRejected(rejected);
      }
      return outcome;
    });
  } catch (error) {
    if (error instanceof CommandRejected) {
      return Result.err(error.reason);
    }
    throw error;
  }
  if (!advanced.ok) {
    return advanced;
  }
  if (!deps.dbExecutor) {
    await reportRunCompletion(advanced.value.completion, deps);
    await deleteTaskSessions(advanced.value.endedSessionObjectKeys, deps);
  }
  const [pipelineExecution] = await projectPipelineRunsToContracts(
    [advanced.value.run],
    deps,
  );
  if (!pipelineExecution) {
    return Result.err(new ResourceNotFoundError("Pipeline run", run.id));
  }
  return Result.ok({ advanced: advanced.value, pipelineExecution });
};

/** Wraps an event that needs no lookups. */
export const fixedEvent =
  (event: EngineEvent): PipelineRunCommand["event"] =>
  () =>
    Promise.resolve(Result.ok(event));

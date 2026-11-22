import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { InvariantViolationError } from "@scarn/core/lib/errors";
import type {
  TaskPipelineRunPort,
  TaskVisitBaseBranch,
} from "@scarn/core/tasks/task/application/task-pipeline-run-port";
import { visitBaseBranch } from "../domain/engine/decide";
import {
  loadRunState,
  type AdvancePipelineRunDeps,
} from "./advance-pipeline-run";

export type VisitBaseBranchDeps = Pick<
  AdvancePipelineRunDeps,
  | "pipelineRunRepo"
  | "pipelineGraphVersionRepo"
  | "workItemRepo"
  | "nodeVisitQuestionRepo"
  | "taskRunRepo"
>;

/**
 * The base branch of the step visit that owns `taskId`, worked out from the
 * run as the engine did when it entered the visit; null for a standalone
 * Task. A visit's Task that waited for a concurrency slot has no run to
 * carry the branch, so its first run reads it here.
 */
export const findVisitBaseBranch = async (
  taskId: UuidV7,
  deps: VisitBaseBranchDeps,
  tx: DbExecutor,
): Promise<TaskVisitBaseBranch | null> => {
  const pipelineRunId = await deps.pipelineRunRepo.findRunIdByTaskId(
    taskId,
    tx,
  );
  if (!pipelineRunId) {
    return null;
  }
  const run = await deps.pipelineRunRepo.load(pipelineRunId, tx);
  const version = run
    ? await deps.pipelineGraphVersionRepo.load(run.pipelineGraphVersionId, tx)
    : null;
  if (!run || !version) {
    throw new InvariantViolationError(
      `Task ${taskId}'s pipeline run ${pipelineRunId} or its version is missing`,
      "PIPELINE_RUN_MISSING_FOR_TASK",
    );
  }
  const { state } = await loadRunState(run, deps, tx);
  const visit = state.visits.find((each) => each.taskId === taskId);
  if (!visit) {
    throw new InvariantViolationError(
      `No visit of run ${pipelineRunId} owns Task ${taskId}`,
      "PIPELINE_RUN_VISIT_MISSING",
    );
  }
  return {
    baseBranch: visitBaseBranch(version.definitionJson, state, visit.id),
  };
};

/** `TaskPipelineRunPort` over the pipeline run tables. */
export const pipelineTaskPipelineRunPort = (
  deps: VisitBaseBranchDeps,
): TaskPipelineRunPort => ({
  findForTask: (taskId, tx) =>
    deps.pipelineRunRepo.findRunStarterByTaskId(taskId, tx),
  findVisitBaseBranch: (taskId, tx) => findVisitBaseBranch(taskId, deps, tx),
});

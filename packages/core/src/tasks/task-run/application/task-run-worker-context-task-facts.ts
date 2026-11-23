import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { StepDefinitionRepo } from "@scarn/core/pipeline-definitions/step-definition/application/step-definition-repo";
import { countContinuationRuns } from "@scarn/core/tasks/task/application/on-run-ended";
import type { TaskRepo } from "@scarn/core/tasks/task/application/task-repo";
import { taskGrants, type Grant } from "@scarn/core/tasks/task/domain/grants";
import type { ExtraConnector } from "@scarn/core/tasks/task/domain/task-environment-selection";
import { turnsLeft } from "@scarn/core/tasks/task/domain/task-turns";
import type { TaskRunEntity } from "../domain/task-run-entity";
import type { TaskRunRepo } from "./task-run-repo";

export type TaskFacts = {
  turnsRemaining: number | null;
  grants: Grant[];
  chatConversationId: UuidV7 | null;
  extraConnectors: ExtraConnector[];
  declaredErrors: string[];
};

/**
 * What `run`'s Task contributes: how many more times `run` may hand over (its
 * turns left as of `run`), which work items its agent may change, the
 * conversation of a chat (a Task with no work item), the extra connectors it
 * selected, and the error names its step definition declares.
 */
export const loadTaskFacts = async (
  run: TaskRunEntity,
  deps: {
    taskRepo: Pick<TaskRepo, "load">;
    taskRunRepo: Pick<TaskRunRepo, "listByTaskId">;
    stepDefinitionRepo: Pick<StepDefinitionRepo, "load">;
  },
): Promise<TaskFacts> => {
  const task = await deps.taskRepo.load(run.taskId);
  const grants = task
    ? [...task.grants]
    : taskGrants([], {
        workItemId: run.workItemId,
        startedByScheduleId: null,
      });
  const chatConversationId =
    task && task.workItemId === null && task.startedByScheduleId === null
      ? task.conversationId
      : null;
  const extraConnectors = task?.environmentSelection?.extraConnectors ?? [];
  const stepDefinition = task?.stepDefinitionId
    ? await deps.stepDefinitionRepo.load(task.stepDefinitionId)
    : null;
  const declaredErrors = stepDefinition ? [...stepDefinition.errors] : [];
  const turnsRemaining =
    !task || task.maxTurns === null
      ? null
      : turnsLeft(task, await countContinuationRuns(run, deps.taskRunRepo));
  return {
    turnsRemaining,
    grants,
    chatConversationId,
    extraConnectors,
    declaredErrors,
  };
};

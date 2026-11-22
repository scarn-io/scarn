import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";

/**
 * The step key a Task was queued for, when something outside `tasks/`
 * created it from a step (a pipeline visit). Standalone Tasks have none.
 * The worker uses the key to find a code step's function in its module.
 */
export type TaskRunStepKeyReader = {
  loadStepKey(taskRunId: UuidV7): Promise<string | null>;
};

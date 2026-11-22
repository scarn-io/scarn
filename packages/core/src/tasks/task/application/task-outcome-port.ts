import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TaskRunEntity } from "@scarn/core/tasks/task-run/domain/task-run-entity";
import type { TaskEntity } from "../domain/task-entity";

/**
 * Told, in the transaction that changed it, when a Task's status changed
 * because one of its runs ended (`run` is that run) or a person ended its
 * conversation (`run` is its latest run), and when a person's reply resumed
 * a Task waiting for them (`run` is the continuation it queued). The
 * pipeline side implements it to advance the run whose visit owns the Task.
 */
export type TaskOutcomePort = {
  taskChanged(
    task: TaskEntity,
    run: TaskRunEntity,
    tx: DbExecutor,
  ): Promise<void>;
  taskResumed(
    task: TaskEntity,
    run: TaskRunEntity,
    tx: DbExecutor,
  ): Promise<void>;
};

/** For standalone Tasks: nothing listens. */
export const noopTaskOutcomePort: TaskOutcomePort = {
  taskChanged: async () => {},
  taskResumed: async () => {},
};

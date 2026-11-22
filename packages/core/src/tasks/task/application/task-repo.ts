import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TaskEntity, TaskStatus } from "../domain/task-entity";

/** A concurrency group: the Tasks of one step key on one work item. */
export type ConcurrencyGroupKey = {
  projectId: UuidV7;
  stepKey: string;
  workItemId: UuidV7;
};

export type TaskRepo = {
  load(id: UuidV7, dbExecutor?: DbExecutor): Promise<TaskEntity | null>;
  /** Locks the Task row until the transaction ends. */
  lock(id: UuidV7, dbExecutor: DbExecutor): Promise<TaskEntity | null>;
  /**
   * The status of each given work item's newest Task, in one query, with its
   * latest run's liveness clocks applied. Items that have never had a Task
   * have no entry.
   */
  loadLatestStatusByWorkItemIds(
    workItemIds: UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<Map<UuidV7, TaskStatus>>;
  create(task: TaskEntity, dbExecutor?: DbExecutor): Promise<TaskEntity>;
  /**
   * Takes the transaction-scoped advisory lock of a concurrency group (a
   * step key on a work item), so arrivals and promotions in it take turns.
   */
  lockConcurrencyGroup(
    group: ConcurrencyGroupKey,
    dbExecutor: DbExecutor,
  ): Promise<void>;
  /**
   * Takes the transaction-scoped advisory lock on a Task's spawned work
   * items, so its agent's creates take turns counting against the caps.
   */
  lockSpawnedWorkItems(taskId: UuidV7, dbExecutor: DbExecutor): Promise<void>;
  /**
   * The group's Tasks that haven't ended, from every version of the step
   * key, oldest first.
   */
  listLiveInConcurrencyGroup(
    group: ConcurrencyGroupKey,
    dbExecutor: DbExecutor,
  ): Promise<TaskEntity[]>;
  /**
   * The group's `waiting_for_concurrency_slot` Tasks, oldest first, locked
   * for update; rows another transaction holds (one cancelling them) are
   * skipped.
   */
  lockWaitingInConcurrencyGroup(
    group: ConcurrencyGroupKey,
    dbExecutor: DbExecutor,
  ): Promise<TaskEntity[]>;
  /**
   * The `waiting_for_work` Tasks on the given work items, locked for update
   * until the transaction ends, so two changes that each free the same Task
   * take turns and see each other's writes.
   */
  lockWaitingForWorkByWorkItemIds(
    workItemIds: UuidV7[],
    dbExecutor: DbExecutor,
  ): Promise<TaskEntity[]>;
  /**
   * The Task whose conversation is `conversationId`, locked for update until
   * the transaction ends; null when no Task owns it.
   */
  lockByConversationId(
    conversationId: UuidV7,
    dbExecutor: DbExecutor,
  ): Promise<TaskEntity | null>;
  /** Writes the Task's `status`, `resultJson` and `errorJson`. */
  save(task: TaskEntity, dbExecutor?: DbExecutor): Promise<TaskEntity>;
  /**
   * Deletes the given Tasks, cascading to their runs (and through them to
   * log lines, artifacts and artifact resolutions). Callers first remove
   * anything that restrict-references them (`node_visits.task_id`). A Task
   * that is another Task's `previous_task_id` can only go in the same call
   * as that Task. Returns the number deleted.
   */
  deleteMany(ids: UuidV7[], dbExecutor?: DbExecutor): Promise<number>;
  /** `deleteMany` for every Task in the project. */
  deleteByProjectId(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<number>;
};

import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type {
  PrunableScheduledTask,
  ScheduledTaskRetentionPolicy,
} from "@scarn/core/tasks/scheduled-task-retention/domain/scheduled-task-retention";
import type { TaskEntity, TaskStatus } from "../domain/task-entity";

/** A concurrency group of the Tasks of one step key on one work item. */
export type StepConcurrencyGroupKey = {
  projectId: UuidV7;
  stepKey: string;
  workItemId: UuidV7;
};

/** A concurrency group of the Tasks one schedule started. */
export type ScheduleConcurrencyGroupKey = {
  projectId: UuidV7;
  scheduleId: UuidV7;
};

export type ConcurrencyGroupKey =
  StepConcurrencyGroupKey | ScheduleConcurrencyGroupKey;

export const isScheduleConcurrencyGroup = (
  group: ConcurrencyGroupKey,
): group is ScheduleConcurrencyGroupKey => "scheduleId" in group;

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
   * The `scheduledFor` of the latest succeeded Task the schedule started;
   * null when none has succeeded.
   */
  findLatestSucceededScheduledFor(
    scheduleId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<Date | null>;
  /**
   * Up to `limit` ended Tasks, across every schedule, that `policy` lets go
   * (see `scheduled-task-retention.ts`), oldest `scheduledFor` first. Never
   * returns a Task with a conversation, one another Task's
   * `previous_task_id` points at, or one a node visit points at.
   */
  listPrunableScheduled(
    policy: ScheduledTaskRetentionPolicy,
    limit: number,
    dbExecutor?: DbExecutor,
  ): Promise<PrunableScheduledTask[]>;
  /**
   * The given Tasks that `policy` still lets go, locked for update until the
   * transaction ends. Rows another transaction holds are skipped. The rule
   * is checked again after the lock, which also keeps new references
   * (`previous_task_id`, node visits) from arriving before the delete.
   */
  lockPrunableScheduled(
    ids: UuidV7[],
    policy: ScheduledTaskRetentionPolicy,
    dbExecutor: DbExecutor,
  ): Promise<PrunableScheduledTask[]>;
  /**
   * Takes the transaction-scoped advisory lock of a concurrency group (a
   * step key on a work item, or a schedule), so arrivals and promotions in
   * it take turns.
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
   * The group's Tasks that haven't ended, oldest first: from every version
   * of the step key on the work item, or every Task the schedule started.
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
  /**
   * Writes the Task's `status`, `resultJson`, `errorJson`, conversation,
   * `maxTurns`, grants and held work item changes.
   */
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

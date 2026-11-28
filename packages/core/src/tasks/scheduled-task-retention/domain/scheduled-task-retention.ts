import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { TaskStatus } from "@scarn/core/tasks/task/domain/task-entity";

/**
 * How many Tasks a schedule keeps. A schedule starts a Task on every fire
 * (about 8,640 a month at `*\/5 * * * *`), and nothing else deletes them, so a
 * daily job prunes old, finished ones. Per schedule it keeps:
 *
 * - every Task that hasn't ended (never touches live work);
 * - the latest succeeded Task, which `fireSchedule` reads for
 *   `event.schedule.previousScheduledFor`;
 * - the newest {@link SCHEDULED_TASK_RETENTION_COUNT} ended Tasks, by
 *   `scheduledFor`;
 * - failed Tasks scheduled within the last
 *   {@link SCHEDULED_TASK_FAILURE_RETENTION_DAYS} days, so failures stay
 *   debuggable however often the schedule fires.
 *
 * It never deletes a Task with a conversation (its own deletion contract), one
 * another Task continues (`previous_task_id`), or one a node visit points at.
 */
export const SCHEDULED_TASK_RETENTION_COUNT = 50;
export const SCHEDULED_TASK_FAILURE_RETENTION_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

export type ScheduledTaskRetentionPolicy = {
  /** Ended Tasks each schedule keeps, newest first. At least 1. */
  keepNewest: number;
  /** Failed Tasks scheduled at or after this are kept. */
  keepFailedScheduledSince: Date;
};

export const scheduledTaskRetentionPolicy = (
  now: Date,
  {
    keepNewest = SCHEDULED_TASK_RETENTION_COUNT,
    failureRetentionDays = SCHEDULED_TASK_FAILURE_RETENTION_DAYS,
  }: { keepNewest?: number; failureRetentionDays?: number } = {},
): ScheduledTaskRetentionPolicy => {
  if (!Number.isInteger(keepNewest) || keepNewest < 1) {
    throw new Error("keepNewest must be a positive whole number");
  }
  return {
    keepNewest,
    keepFailedScheduledSince: new Date(
      now.getTime() - failureRetentionDays * MS_PER_DAY,
    ),
  };
};

/** A scheduled Task the retention rule lets go. */
export type PrunableScheduledTask = {
  id: UuidV7;
  projectId: UuidV7;
};

/** What the retention rule reads about one Task a schedule started. */
export type ScheduledTaskSnapshot = PrunableScheduledTask & {
  scheduleId: UuidV7;
  status: TaskStatus;
  scheduledFor: Date;
  hasConversation: boolean;
  /** Another Task's `previous_task_id`, or a node visit, points at it. */
  referenced: boolean;
};

const ENDED: ReadonlySet<TaskStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

const newestFirst = (a: ScheduledTaskSnapshot, b: ScheduledTaskSnapshot) =>
  b.scheduledFor.getTime() - a.scheduledFor.getTime() ||
  (b.id < a.id ? -1 : b.id > a.id ? 1 : 0);

/**
 * The retention rule over in-memory Tasks: up to `limit` Tasks to delete,
 * oldest `scheduledFor` first. The task repo's `listPrunableScheduled` is
 * the same rule in SQL; tests hold the two to the same answers.
 */
export const selectPrunableScheduledTasks = (
  tasks: readonly ScheduledTaskSnapshot[],
  policy: ScheduledTaskRetentionPolicy,
  limit: number,
): PrunableScheduledTask[] => {
  const bySchedule = new Map<UuidV7, ScheduledTaskSnapshot[]>();
  for (const task of tasks) {
    bySchedule.set(task.scheduleId, [
      ...(bySchedule.get(task.scheduleId) ?? []),
      task,
    ]);
  }
  const prunable: ScheduledTaskSnapshot[] = [];
  for (const scheduleTasks of bySchedule.values()) {
    const latestSucceeded = scheduleTasks
      .filter((task) => task.status === "succeeded")
      .sort(newestFirst)[0];
    const ended = scheduleTasks
      .filter((task) => ENDED.has(task.status))
      .sort(newestFirst);
    for (const task of ended.slice(policy.keepNewest)) {
      const recentFailure =
        task.status === "failed" &&
        task.scheduledFor >= policy.keepFailedScheduledSince;
      if (
        task !== latestSucceeded &&
        !recentFailure &&
        !task.hasConversation &&
        !task.referenced
      ) {
        prunable.push(task);
      }
    }
  }
  return prunable
    .sort((a, b) => newestFirst(b, a))
    .slice(0, limit)
    .map(({ id, projectId }) => ({ id, projectId }));
};

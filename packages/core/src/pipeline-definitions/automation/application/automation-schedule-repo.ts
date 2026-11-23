import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TaskStatus } from "@scarn/core/tasks/task/domain/task-entity";
import type { AutomationScheduleEntity } from "../domain/automation-schedule-entity";

/** A live schedule with what its scheduled Tasks say about it. */
export type AutomationScheduleSummaryRecord = {
  schedule: AutomationScheduleEntity;
  /** The schedule's Task with the latest `scheduledFor`, its status with liveness clocks applied. */
  lastTask: { id: UuidV7; status: TaskStatus; scheduledFor: Date } | null;
  /**
   * Failed Tasks since the latest succeeded one (all of them when none
   * succeeded); cancelled Tasks neither count nor break the streak.
   */
  failureStreak: number;
};

export type AutomationScheduleRepo = {
  /** The schedule, removed or not; null when there's no such row. */
  load(
    id: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<AutomationScheduleEntity | null>;
  /** The automation's live schedule with this rule key; null when there's none. */
  findLive(
    automationId: UuidV7,
    key: string,
    dbExecutor?: DbExecutor,
  ): Promise<AutomationScheduleEntity | null>;
  /** The automation's schedules that aren't removed, in key order. */
  listLiveByAutomationId(
    automationId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<AutomationScheduleEntity[]>;
  /** The live schedules of these automations with their summaries, in key order. */
  listSummariesByAutomationIds(
    automationIds: readonly UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<AutomationScheduleSummaryRecord[]>;
  /**
   * How many live schedules the project's enabled automations have, leaving
   * out `exceptAutomationId`'s.
   */
  countLiveEnabledInProject(
    projectId: UuidV7,
    exceptAutomationId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<number>;
  insert(
    schedule: AutomationScheduleEntity,
    dbExecutor?: DbExecutor,
  ): Promise<AutomationScheduleEntity>;
  /** Writes the settings, `nextRunAt` and `removedAt`; the summary columns belong to the tick. */
  update(
    schedule: AutomationScheduleEntity,
    dbExecutor?: DbExecutor,
  ): Promise<AutomationScheduleEntity>;
  /**
   * Locks the live schedule of an enabled automation that has been due the
   * longest (`nextRunAt <= now`) with `FOR UPDATE SKIP LOCKED`, so concurrent
   * ticks never claim the same one; null when none is due and unlocked.
   */
  claimNextDue(
    now: Date,
    dbExecutor: DbExecutor,
  ): Promise<AutomationScheduleEntity | null>;
  /** How many live schedules of enabled automations are due at `now`. */
  countDue(now: Date, dbExecutor?: DbExecutor): Promise<number>;
  /** Moves `nextRunAt`, leaving the settings and the summary as they are. */
  advanceNextRunAt(
    id: UuidV7,
    nextRunAt: Date,
    now: Date,
    dbExecutor?: DbExecutor,
  ): Promise<void>;
  /** A fire started a Task (or skipped by route): sets `lastFiredAt` and resets `skippedCountSinceFire`. */
  recordFired(id: UuidV7, now: Date, dbExecutor?: DbExecutor): Promise<void>;
  /** A fire found the concurrency group full: sets `lastSkippedAt` and counts the skip. */
  recordSkipped(id: UuidV7, now: Date, dbExecutor?: DbExecutor): Promise<void>;
  /** A fire failed: records the error and advances `nextRunAt` past the failed time. */
  recordError(
    id: UuidV7,
    error: { message: string; at: Date; nextRunAt: Date },
    dbExecutor?: DbExecutor,
  ): Promise<void>;
};

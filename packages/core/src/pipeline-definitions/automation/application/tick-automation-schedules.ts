import { getDb } from "@scarn/core/lib/db";
import type { DbTransaction } from "@scarn/core/lib/db/db-executor";
import type { WorkSignal } from "@scarn/core/tasks/task-run/application/work-signal";
import { runWithWorkNotifyScope } from "@scarn/core/tasks/task-run/application/work-notifier";
import {
  latestCronTimeAtOrBefore,
  nextCronTime,
} from "@scarn/sdk/contracts/automation-document";
import type { Logger } from "@scarn/observability/logging";
import type { AutomationScheduleEntity } from "../domain/automation-schedule-entity";
import type { AutomationRepo } from "./automation-repo";
import type { AutomationScheduleRepo } from "./automation-schedule-repo";
import {
  fireSchedule,
  type FireScheduleDeps,
  type FireScheduleResult,
} from "./fire-schedule";

/** How many schedules one tick handles; the rest wait for the next tick. */
export const SCHEDULE_TICK_BATCH_LIMIT = 50;

export type TickAutomationSchedulesDeps = FireScheduleDeps & {
  automationRepo: Pick<AutomationRepo, "loadMany" | "loadLatestVersion">;
  automationScheduleRepo: Pick<
    AutomationScheduleRepo,
    | "claimNextDue"
    | "countDue"
    | "advanceNextRunAt"
    | "recordFired"
    | "recordSkipped"
    | "recordError"
  >;
  workSignal: WorkSignal;
  logger: Logger;
};

export type TickAutomationSchedulesOptions = {
  batchLimit?: number;
};

export type TickAutomationSchedulesResult = {
  /** Schedules whose rule ran: a Task started, or the rule routed to `skip` or nothing. */
  fired: number;
  /** Schedules whose concurrency group was full. */
  skipped: number;
  /**
   * Schedules that had missed more than one cron time: they ran once, for the
   * latest due time, and the earlier ones were dropped. Counts schedules, not
   * dropped times.
   */
  collapsed: number;
  /** Schedules whose run failed to start; each records `lastError`. */
  errored: number;
  /** Schedules still due when the tick hit its batch limit. */
  deferred: number;
};

type Handled = { kind: "fired" | "skipped" | "errored"; collapsed: boolean };

const nextRunAfter = (schedule: AutomationScheduleEntity, now: Date): Date => {
  const next = nextCronTime(schedule.cron, schedule.timezone, now);
  if (next === null) {
    throw new Error(
      `Schedule ${schedule.id}: cron "${schedule.cron}" never matches again`,
    );
  }
  return next;
};

/**
 * The cron time a due schedule runs for: the latest one at or before `now`.
 * Missed times collapse into it; none are backfilled.
 */
const scheduledForOf = (
  schedule: AutomationScheduleEntity,
  now: Date,
): Date => {
  const latest = latestCronTimeAtOrBefore(
    schedule.cron,
    schedule.timezone,
    now,
  );
  return latest !== null && latest > schedule.nextRunAt
    ? latest
    : schedule.nextRunAt;
};

const fireInSavepoint = async (
  schedule: AutomationScheduleEntity,
  scheduledFor: Date,
  deps: TickAutomationSchedulesDeps,
  tx: DbTransaction,
): Promise<FireScheduleResult> =>
  await tx.transaction(async (savepoint) => {
    const [automation] = await deps.automationRepo.loadMany(
      [schedule.automationId],
      savepoint,
    );
    if (!automation) {
      throw new Error(`Automation ${schedule.automationId} not found`);
    }
    const latestVersion = await deps.automationRepo.loadLatestVersion(
      automation.id,
      savepoint,
    );
    return await fireSchedule(
      { schedule, automation: { automation, latestVersion }, scheduledFor },
      deps,
      savepoint,
    );
  });

/**
 * Claims and runs the longest-due schedule in its own transaction; null when
 * none is due. The claim moves `nextRunAt` to the next cron time after `now`
 * whatever happens next. A start that throws is rolled back to a savepoint,
 * and the error is recorded on the still-locked schedule, so a broken
 * schedule retries once per cron time and no other tick can claim it between
 * the failure and the record.
 */
const handleNextDue = async (
  now: Date,
  deps: TickAutomationSchedulesDeps,
): Promise<Handled | null> =>
  await getDb().transaction(async (tx) => {
    const schedule = await deps.automationScheduleRepo.claimNextDue(now, tx);
    if (!schedule) {
      return null;
    }
    const scheduledFor = scheduledForOf(schedule, now);
    const collapsed = scheduledFor > schedule.nextRunAt;
    const nextRunAt = nextRunAfter(schedule, now);
    await deps.automationScheduleRepo.advanceNextRunAt(
      schedule.id,
      nextRunAt,
      now,
      tx,
    );
    try {
      const result = await fireInSavepoint(schedule, scheduledFor, deps, tx);
      return { kind: result.outcome, collapsed };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.warn(
        {
          err: error,
          scheduleId: schedule.id,
          automationId: schedule.automationId,
          scheduledFor: scheduledFor.toISOString(),
        },
        "automation schedule failed to start its run",
      );
      await deps.automationScheduleRepo.recordError(
        schedule.id,
        { message, at: now, nextRunAt },
        tx,
      );
      return { kind: "errored", collapsed };
    }
  });

/**
 * One cron tick over every project's schedules (docs/plans/automation-schedules.md,
 * decisions 19–23): claims due schedules one per transaction with
 * `FOR UPDATE SKIP LOCKED`, so overlapping ticks never fire one twice, runs
 * each for its latest due cron time, and stops after `batchLimit`. Errors are
 * per schedule; only a failure of the tick itself throws. A tick with nothing
 * due opens no transaction. Every Task started
 * wakes its project's workers once, when the tick ends.
 */
export const tickAutomationSchedules = async (
  deps: TickAutomationSchedulesDeps,
  {
    batchLimit = SCHEDULE_TICK_BATCH_LIMIT,
  }: TickAutomationSchedulesOptions = {},
): Promise<TickAutomationSchedulesResult> =>
  await runWithWorkNotifyScope(deps.workSignal, deps.logger, async () => {
    const now = deps.timeProvider.now();
    const result: TickAutomationSchedulesResult = {
      fired: 0,
      skipped: 0,
      collapsed: 0,
      errored: 0,
      deferred: 0,
    };
    if ((await deps.automationScheduleRepo.countDue(now)) === 0) {
      return result;
    }
    for (let handled = 0; handled < batchLimit; handled += 1) {
      const outcome = await handleNextDue(now, deps);
      if (!outcome) {
        return result;
      }
      result[outcome.kind] += 1;
      if (outcome.collapsed) {
        result.collapsed += 1;
      }
    }
    result.deferred = await deps.automationScheduleRepo.countDue(now);
    return result;
  });

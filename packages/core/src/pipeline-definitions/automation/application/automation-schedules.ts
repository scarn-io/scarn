/**
 * Keeps `automation_schedules` in step with a project automation's latest
 * version, and the per-project limit on schedules that can fire.
 *
 * Publishing syncs schedules by rule key: a new key gets a schedule due at
 * the next cron time; the same key with the same cron and timezone keeps its
 * next run and takes the new concurrency; a changed cron or timezone
 * recomputes the next run from now; a key no longer in the document is
 * removed, and publishing it again starts a new schedule.
 */
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { CoreValidationError } from "@scarn/core/lib/errors";
import {
  schedulesOf,
  type AutomationDocument,
} from "@scarn/sdk/contracts/automation-document";
import type { AutomationEntity } from "../domain/automation-entity";
import { AutomationScheduleEntity } from "../domain/automation-schedule-entity";
import type { AutomationScheduleRepo } from "./automation-schedule-repo";

/** The most live schedules a project's enabled automations may have together. */
export const MAX_ENABLED_SCHEDULES_PER_PROJECT = 20;

/**
 * Fails when `automation`, enabled with `scheduleCount` schedules, would
 * take the project's enabled schedules over the limit.
 */
export const checkScheduleLimit = async (
  automation: AutomationEntity,
  scheduleCount: number,
  automationScheduleRepo: AutomationScheduleRepo,
  tx: DbExecutor,
): Promise<CoreValidationError | null> => {
  if (scheduleCount === 0) {
    return null;
  }
  const others = await automationScheduleRepo.countLiveEnabledInProject(
    automation.projectId,
    automation.id,
    tx,
  );
  if (others + scheduleCount <= MAX_ENABLED_SCHEDULES_PER_PROJECT) {
    return null;
  }
  return new CoreValidationError(
    `A project's enabled automations can have at most ${String(MAX_ENABLED_SCHEDULES_PER_PROJECT)} schedules; other enabled automations have ${String(others)} and '${automation.key}' has ${String(scheduleCount)}`,
    "AUTOMATION_SCHEDULE_LIMIT_EXCEEDED",
    {
      limit: MAX_ENABLED_SCHEDULES_PER_PROJECT,
      otherSchedules: others,
      automationSchedules: scheduleCount,
    },
  );
};

/** Syncs the automation's schedules with `document`, its new latest version. */
export const syncAutomationSchedules = async (
  automation: AutomationEntity,
  document: AutomationDocument,
  now: Date,
  automationScheduleRepo: AutomationScheduleRepo,
  tx: DbExecutor,
): Promise<void> => {
  const live = new Map(
    (
      await automationScheduleRepo.listLiveByAutomationId(automation.id, tx)
    ).map((schedule) => [schedule.key, schedule]),
  );
  const published = schedulesOf(document);
  const publishedKeys = new Set(published.map((settings) => settings.key));
  for (const schedule of live.values()) {
    if (!publishedKeys.has(schedule.key)) {
      await automationScheduleRepo.update(schedule.remove(now), tx);
    }
  }
  for (const settings of published) {
    const existing = live.get(settings.key);
    await (existing
      ? automationScheduleRepo.update(existing.withSettings(settings, now), tx)
      : automationScheduleRepo.insert(
          AutomationScheduleEntity.create(automation.id, settings, now),
          tx,
        ));
  }
};

/** Makes the automation's schedules due at their next cron time after `now`, as on enable. */
export const rescheduleAutomationSchedules = async (
  schedules: readonly AutomationScheduleEntity[],
  now: Date,
  automationScheduleRepo: AutomationScheduleRepo,
  tx: DbExecutor,
): Promise<void> => {
  for (const schedule of schedules) {
    await automationScheduleRepo.update(schedule.rescheduledFrom(now), tx);
  }
};

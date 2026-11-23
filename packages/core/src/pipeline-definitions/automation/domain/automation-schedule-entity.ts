import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { CoreValidationError } from "@scarn/core/lib/errors";
import { normalizeDate } from "@scarn/core/work-items/work-item/domain/date-utils";
import {
  nextCronTime,
  type ScheduleConcurrency,
  type ScheduleSettings,
} from "@scarn/sdk/contracts/automation-document";

export type AutomationScheduleEntityProps = {
  id: UuidV7;
  automationId: UuidV7;
  key: string;
  cron: string;
  timezone: string;
  concurrency: ScheduleConcurrency;
  nextRunAt: Date | string;
  lastFiredAt: Date | string | null;
  lastSkippedAt: Date | string | null;
  skippedCountSinceFire: number;
  lastError: string | null;
  lastErrorAt: Date | string | null;
  removedAt: Date | string | null;
};

const nextRunAfter = (
  settings: Pick<ScheduleSettings, "cron" | "timezone">,
  now: Date,
): Date => {
  const next = nextCronTime(settings.cron, settings.timezone, now);
  if (next === null) {
    throw new CoreValidationError(
      `Cron "${settings.cron}" never matches again`,
      "AUTOMATION_SCHEDULE_CRON_INVALID",
    );
  }
  return next;
};

/**
 * A `schedule` rule of a project automation, kept in step with the
 * automation's latest version by publish. `nextRunAt` is the next cron time
 * the tick starts a run for. A removed schedule (`removedAt` set) never
 * fires again; publishing its key again creates a new schedule.
 */
export class AutomationScheduleEntity {
  public readonly id: UuidV7;
  public readonly automationId: UuidV7;
  public readonly key: string;
  public readonly cron: string;
  public readonly timezone: string;
  public readonly concurrency: ScheduleConcurrency;
  public readonly nextRunAt: Date;
  public readonly lastFiredAt: Date | null;
  public readonly lastSkippedAt: Date | null;
  public readonly skippedCountSinceFire: number;
  public readonly lastError: string | null;
  public readonly lastErrorAt: Date | null;
  public readonly removedAt: Date | null;

  private constructor(props: AutomationScheduleEntityProps) {
    const nextRunAt = normalizeDate(props.nextRunAt);
    if (!nextRunAt) {
      throw new CoreValidationError(
        "A schedule needs a next run time",
        "AUTOMATION_SCHEDULE_NEXT_RUN_REQUIRED",
      );
    }
    this.id = parseUuidV7(props.id);
    this.automationId = parseUuidV7(props.automationId);
    this.key = props.key;
    this.cron = props.cron;
    this.timezone = props.timezone;
    this.concurrency = props.concurrency;
    this.nextRunAt = nextRunAt;
    this.lastFiredAt = normalizeDate(props.lastFiredAt) ?? null;
    this.lastSkippedAt = normalizeDate(props.lastSkippedAt) ?? null;
    this.skippedCountSinceFire = props.skippedCountSinceFire;
    this.lastError = props.lastError;
    this.lastErrorAt = normalizeDate(props.lastErrorAt) ?? null;
    this.removedAt = normalizeDate(props.removedAt) ?? null;
  }

  /** A new schedule for a published rule, due at the next cron time after `now`. */
  static create(
    automationId: UuidV7,
    settings: ScheduleSettings,
    now: Date,
  ): AutomationScheduleEntity {
    return new AutomationScheduleEntity({
      id: createUuidV7(),
      automationId,
      key: settings.key,
      cron: settings.cron,
      timezone: settings.timezone,
      concurrency: settings.concurrency,
      nextRunAt: nextRunAfter(settings, now),
      lastFiredAt: null,
      lastSkippedAt: null,
      skippedCountSinceFire: 0,
      lastError: null,
      lastErrorAt: null,
      removedAt: null,
    });
  }

  static rehydrate(
    props: AutomationScheduleEntityProps,
  ): AutomationScheduleEntity {
    return new AutomationScheduleEntity(props);
  }

  /**
   * The schedule after its rule was published again. Same cron and timezone
   * keep `nextRunAt`; a changed one recomputes it from `now`.
   */
  withSettings(
    settings: ScheduleSettings,
    now: Date,
  ): AutomationScheduleEntity {
    const timingChanged =
      settings.cron !== this.cron || settings.timezone !== this.timezone;
    return new AutomationScheduleEntity({
      ...this.toJSON(),
      cron: settings.cron,
      timezone: settings.timezone,
      concurrency: settings.concurrency,
      nextRunAt: timingChanged ? nextRunAfter(settings, now) : this.nextRunAt,
    });
  }

  /** Due at the next cron time after `now`, as when the automation is enabled. */
  rescheduledFrom(now: Date): AutomationScheduleEntity {
    return new AutomationScheduleEntity({
      ...this.toJSON(),
      nextRunAt: nextRunAfter(this, now),
    });
  }

  /** The rule is gone from the latest version. */
  remove(now: Date): AutomationScheduleEntity {
    return new AutomationScheduleEntity({ ...this.toJSON(), removedAt: now });
  }

  toJSON(): AutomationScheduleEntityProps {
    return {
      id: this.id,
      automationId: this.automationId,
      key: this.key,
      cron: this.cron,
      timezone: this.timezone,
      concurrency: this.concurrency,
      nextRunAt: this.nextRunAt,
      lastFiredAt: this.lastFiredAt,
      lastSkippedAt: this.lastSkippedAt,
      skippedCountSinceFire: this.skippedCountSinceFire,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      removedAt: this.removedAt,
    };
  }
}

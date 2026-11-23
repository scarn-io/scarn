import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { CoreValidationError } from "@scarn/core/lib/errors";
import type { StepDefinitionRepo } from "@scarn/core/pipeline-definitions/step-definition/application/step-definition-repo";
import {
  startTaskFromStepDefinition,
  type StartTaskDeps,
} from "@scarn/core/tasks/task/application/start-task-from-step-definition";
import type {
  AutomationTargetJson,
  ScheduleRule,
} from "@scarn/sdk/contracts/automation-document";
import type { AutomationScheduleEntity } from "../domain/automation-schedule-entity";
import type { ResolvedAutomation } from "./automation-repo";
import type { AutomationScheduleRepo } from "./automation-schedule-repo";
import {
  resolveTargetArgs,
  selectTargets,
  type ScheduleEventContext,
} from "./automation-event-context";

export type FireScheduleDeps = StartTaskDeps & {
  stepDefinitionRepo: Pick<StepDefinitionRepo, "listLatestActiveByKeys">;
  automationScheduleRepo: Pick<
    AutomationScheduleRepo,
    "recordFired" | "recordSkipped"
  >;
};

export type FireScheduleInput = {
  schedule: AutomationScheduleEntity;
  /** The schedule's automation with its latest version, whose rule fires. */
  automation: ResolvedAutomation;
  /** The cron time this run is for (`now` for Run now). */
  scheduledFor: Date;
  /** The person who asked for the run (Run now); null for the tick. */
  startedByUserId?: UuidV7 | null | undefined;
  /**
   * Whether a full concurrency group counts as a skip on the schedule
   * summary. True for the tick; Run now passes false, as a person's click
   * isn't a missed cron time.
   */
  recordSkip?: boolean;
};

export type FireScheduleResult =
  /** The rule ran: `taskId` is the Task it started, null when it routed to `skip` or to nothing. */
  | { outcome: "fired"; taskId: UuidV7 | null }
  /** The schedule's concurrency group is full; `heldBy` are the Tasks holding it, oldest first. */
  | { outcome: "skipped"; heldBy: UuidV7[] };

const scheduleRuleOf = (
  { automation, latestVersion }: ResolvedAutomation,
  schedule: AutomationScheduleEntity,
): ScheduleRule => {
  const rule = latestVersion?.document.rules.find(
    (each): each is ScheduleRule =>
      each.event === "schedule" && each.key === schedule.key,
  );
  if (!rule) {
    throw new CoreValidationError(
      `Automation ${automation.key} has no schedule rule with the key ${schedule.key}`,
      "AUTOMATION_SCHEDULE_RULE_NOT_FOUND",
    );
  }
  return rule;
};

/** The one target a schedule rule picks; it may start at most one Task per run. */
const targetOf = (
  rule: ScheduleRule,
  context: ScheduleEventContext,
): AutomationTargetJson | null => {
  const targets = selectTargets(rule, context);
  if (targets.length > 1) {
    throw new CoreValidationError(
      `Schedule rule ${rule.key} matched ${String(targets.length)} routes; a schedule starts at most one Task per run`,
      "AUTOMATION_SCHEDULE_MANY_TARGETS",
    );
  }
  return targets[0] ?? null;
};

/**
 * Fires one schedule for `scheduledFor`, in `tx`: runs its rule from the
 * automation's latest version with the `event.schedule` refs
 * (`previousScheduledFor` is the latest succeeded run's) and starts the
 * picked step as a Task owned by the schedule, with no work item. The Task
 * arrives at the schedule's concurrency group, not its step's: a full group
 * starts nothing and records a skip (unless `recordSkip` is false); otherwise the fire is recorded, as it is
 * for a `skip` route. No activity lines are written. Start failures (step
 * gone, invalid args, a second run for the same `scheduledFor`) throw, for the
 * caller to roll back. Wake-ups go to the caller's `runWithWorkNotifyScope`.
 */
export const fireSchedule = async (
  {
    schedule,
    automation,
    scheduledFor,
    startedByUserId,
    recordSkip = true,
  }: FireScheduleInput,
  deps: FireScheduleDeps,
  tx: DbExecutor,
): Promise<FireScheduleResult> => {
  const rule = scheduleRuleOf(automation, schedule);
  const previous = await deps.taskRepo.findLatestSucceededScheduledFor(
    schedule.id,
    tx,
  );
  const context: ScheduleEventContext = {
    event: "schedule",
    schedule: {
      key: schedule.key,
      scheduledFor: scheduledFor.toISOString(),
      previousScheduledFor: previous?.toISOString() ?? null,
      timezone: schedule.timezone,
    },
  };
  const target = targetOf(rule, context);
  const now = deps.timeProvider.now();
  if (target?.kind !== "step") {
    if (target && target.kind !== "skip") {
      throw new CoreValidationError(
        `A schedule rule can't start a ${target.kind} target`,
        "AUTOMATION_DOCUMENT_INVALID",
      );
    }
    await deps.automationScheduleRepo.recordFired(schedule.id, now, tx);
    return { outcome: "fired", taskId: null };
  }
  const projectId = automation.automation.projectId;
  const [stepDefinition] = await deps.stepDefinitionRepo.listLatestActiveByKeys(
    projectId,
    [target.to],
    tx,
  );
  if (!stepDefinition) {
    throw new CoreValidationError(
      `No active step definition has the key ${target.to}`,
      "AUTOMATION_STEP_NOT_FOUND",
    );
  }
  const started = await startTaskFromStepDefinition(
    stepDefinition,
    {
      projectId,
      workItemId: null,
      schedule: {
        scheduleId: schedule.id,
        scheduledFor,
        concurrency: schedule.concurrency,
      },
      inputJson: resolveTargetArgs(target.args, context),
      executionTimeoutSeconds: null,
      startedByUserId: startedByUserId ?? null,
      startedByAutomationId: automation.automation.id,
    },
    deps,
    tx,
  );
  if (!started.ok) {
    if (recordSkip) {
      await deps.automationScheduleRepo.recordSkipped(schedule.id, now, tx);
    }
    return { outcome: "skipped", heldBy: started.error.heldBy };
  }
  await deps.automationScheduleRepo.recordFired(schedule.id, now, tx);
  return { outcome: "fired", taskId: started.value.task.id };
};

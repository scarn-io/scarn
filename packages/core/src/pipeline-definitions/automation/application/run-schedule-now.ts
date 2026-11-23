import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { isUniqueViolation } from "@scarn/core/lib/db/unique-violation";
import { CoreError, ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { Logger } from "@scarn/observability/logging";
import { ConcurrencyGroupFullError } from "@scarn/core/tasks/task/application/task-group";
import type { WorkSignal } from "@scarn/core/tasks/task-run/application/work-signal";
import { runWithWorkNotifyScope } from "@scarn/core/tasks/task-run/application/work-notifier";
import {
  runAutomationScheduleInputSchema,
  type RunAutomationScheduleInput,
  type RunAutomationScheduleResult,
} from "../contracts/automation-contracts";
import type { AutomationRepo } from "./automation-repo";
import type { AutomationScheduleRepo } from "./automation-schedule-repo";
import { fireSchedule, type FireScheduleDeps } from "./fire-schedule";

export type RunScheduleNowDeps = FireScheduleDeps & {
  userAuthz: UserAuthorizationService;
  automationRepo: Pick<AutomationRepo, "findByKey" | "loadLatestVersion">;
  automationScheduleRepo: Pick<
    AutomationScheduleRepo,
    "findLive" | "recordFired" | "recordSkipped"
  >;
  workSignal: WorkSignal;
  logger: Logger;
  dbExecutor?: DbExecutor | undefined;
};

export const AUTOMATION_SCHEDULE_RUN_CONFLICT =
  "AUTOMATION_SCHEDULE_RUN_CONFLICT";

type RunScheduleNowError =
  ResourceNotFoundError | ConcurrencyGroupFullError | CoreError;

/**
 * `POST /projects/:projectId/automations/:key/schedules/:ruleKey/runs`
 * (docs/plans/automation-schedules.md, decision 26): fires the schedule once,
 * for `scheduledFor = now`, through the tick's path and concurrency check,
 * recording the person who asked. Works while the automation is disabled and
 * leaves `nextRunAt` alone. A full concurrency group is a 409 and isn't
 * counted as a skip on the schedule summary. A second Run now for the same
 * instant is a 409 as well.
 */
export const runScheduleNow = async (
  input: RunAutomationScheduleInput,
  deps: RunScheduleNowDeps,
): Promise<Result<RunAutomationScheduleResult, RunScheduleNowError>> => {
  const { userAuthz, automationRepo, automationScheduleRepo, dbExecutor } =
    deps;
  const { projectId, key, ruleKey } =
    runAutomationScheduleInputSchema.parse(input);
  await userAuthz.requireProjectPermission({
    projectId,
    permission: "executions:write",
    dbExecutor,
  });
  const run = async (
    tx: DbExecutor,
  ): Promise<Result<RunAutomationScheduleResult, RunScheduleNowError>> => {
    const automation = await automationRepo.findByKey(projectId, key, tx);
    if (!automation) {
      return Result.err(new ResourceNotFoundError("Automation", key));
    }
    if (automation.scope !== "project") {
      return Result.err(
        new CoreError({
          code: "AUTOMATION_NOT_PROJECT_SCOPE",
          message: `'${key}' is a work-item automation; it has no schedules`,
          status: 400,
        }),
      );
    }
    const schedule = await automationScheduleRepo.findLive(
      automation.id,
      ruleKey,
      tx,
    );
    if (!schedule) {
      return Result.err(
        new ResourceNotFoundError("Automation schedule", `${key}/${ruleKey}`),
      );
    }
    const scheduledFor = deps.timeProvider.now();
    const result = await fireSchedule(
      {
        schedule,
        automation: {
          automation,
          latestVersion: await automationRepo.loadLatestVersion(
            automation.id,
            tx,
          ),
        },
        scheduledFor,
        startedByUserId: userAuthz.actorId,
        recordSkip: false,
      },
      deps,
      tx,
    );
    if (result.outcome === "skipped") {
      return Result.err(
        new ConcurrencyGroupFullError(
          { scheduleId: schedule.id },
          result.heldBy,
        ),
      );
    }
    return Result.ok({
      taskId: result.taskId,
      scheduledFor: scheduledFor.toISOString(),
    });
  };
  return await runWithWorkNotifyScope(
    deps.workSignal,
    deps.logger,
    async () => {
      try {
        return dbExecutor
          ? await dbExecutor.transaction(run)
          : await getDb().transaction(run);
      } catch (error) {
        if (isUniqueViolation(error as Error)) {
          return Result.err(
            new CoreError({
              code: AUTOMATION_SCHEDULE_RUN_CONFLICT,
              message: `Schedule ${key}/${ruleKey} already has a run for this instant; try again`,
              status: 409,
            }),
          );
        }
        throw error;
      }
    },
  );
};

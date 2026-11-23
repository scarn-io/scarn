import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { CoreError, ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  setAutomationEnabledInputSchema,
  type AutomationContract,
  type AutomationListItemContract,
  type SetAutomationEnabledInput,
} from "../contracts/automation-contracts";
import type { AutomationEntity } from "../domain/automation-entity";
import type { AutomationRepo } from "./automation-repo";
import type { AutomationScheduleRepo } from "./automation-schedule-repo";
import {
  automationScheduleSummaryToContract,
  automationToContract,
} from "./automation-contract-mapper";
import {
  checkScheduleLimit,
  rescheduleAutomationSchedules,
} from "./automation-schedules";

/** `GET /projects/:projectId/automations`: every automation in the project, in key order. */
export const listAutomations = async (
  projectId: UuidV7,
  {
    userAuthz,
    automationRepo,
    automationScheduleRepo,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    automationRepo: AutomationRepo;
    automationScheduleRepo: AutomationScheduleRepo;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<AutomationListItemContract[]> => {
  await userAuthz.requireProjectPermission({
    projectId,
    permission: "executions:read",
    dbExecutor,
  });
  const resolved = await automationRepo.listByProjectId(projectId, dbExecutor);
  const summaries = await automationScheduleRepo.listSummariesByAutomationIds(
    resolved
      .filter(({ automation }) => automation.scope === "project")
      .map(({ automation }) => automation.id),
    dbExecutor,
  );
  return resolved.map((entry) => ({
    ...automationToContract(entry),
    schedules: summaries
      .filter(
        (summary) => summary.schedule.automationId === entry.automation.id,
      )
      .map((summary) =>
        automationScheduleSummaryToContract(summary, entry.automation.enabled),
      ),
  }));
};

type SetAutomationEnabledDeps = {
  userAuthz: UserAuthorizationService;
  automationRepo: AutomationRepo;
  automationScheduleRepo: AutomationScheduleRepo;
  timeProvider: TimeProvider;
  dbExecutor?: DbExecutor | undefined;
};

const enable = async (
  automation: AutomationEntity,
  {
    automationRepo,
    automationScheduleRepo,
    timeProvider,
  }: SetAutomationEnabledDeps,
  tx: DbExecutor,
): Promise<Result<AutomationEntity, CoreError>> => {
  const schedules = await automationScheduleRepo.listLiveByAutomationId(
    automation.id,
    tx,
  );
  const overLimit = await checkScheduleLimit(
    automation,
    schedules.length,
    automationScheduleRepo,
    tx,
  );
  if (overLimit) {
    return Result.err(overLimit);
  }
  const now = timeProvider.now();
  await rescheduleAutomationSchedules(
    schedules,
    now,
    automationScheduleRepo,
    tx,
  );
  return Result.ok(
    await automationRepo.update(automation.setEnabled(true, now), tx),
  );
};

/**
 * `POST /projects/:projectId/automations/:key/enable|disable`. Only project
 * automations can be enabled: a work-item automation is a `400`. Enabling
 * makes the automation's schedules due at their next cron time, with no
 * backfill, and fails when the project would go over its schedule limit.
 * Disabling leaves the schedules as they are; the tick skips them.
 */
export const setAutomationEnabled = async (
  input: SetAutomationEnabledInput,
  deps: SetAutomationEnabledDeps,
): Promise<Result<AutomationContract, ResourceNotFoundError | CoreError>> => {
  const { userAuthz, automationRepo, timeProvider, dbExecutor } = deps;
  const { projectId, key, enabled } =
    setAutomationEnabledInputSchema.parse(input);
  await userAuthz.requireProjectPermission({
    projectId,
    permission: "pipelines:write",
    dbExecutor,
  });
  const run = async (
    tx: DbExecutor,
  ): Promise<Result<AutomationContract, ResourceNotFoundError | CoreError>> => {
    const automation = await automationRepo.lockByKey(projectId, key, tx);
    if (!automation) {
      return Result.err(new ResourceNotFoundError("Automation", key));
    }
    if (automation.scope !== "project") {
      return Result.err(
        new CoreError({
          code: "AUTOMATION_NOT_PROJECT_SCOPE",
          message: `'${key}' is a work-item automation; attach it to a work item instead of enabling it`,
          status: 400,
        }),
      );
    }
    let updated = automation;
    if (automation.enabled !== enabled) {
      const changed = enabled
        ? await enable(automation, deps, tx)
        : Result.ok(
            await automationRepo.update(
              automation.setEnabled(false, timeProvider.now()),
              tx,
            ),
          );
      if (!changed.ok) {
        return changed;
      }
      updated = changed.value;
    }
    return Result.ok(
      automationToContract({
        automation: updated,
        latestVersion: await automationRepo.loadLatestVersion(updated.id, tx),
      }),
    );
  };
  return dbExecutor
    ? await dbExecutor.transaction(run)
    : await getDb().transaction(run);
};

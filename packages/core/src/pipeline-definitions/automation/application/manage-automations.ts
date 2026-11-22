import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { CoreError, ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  setAutomationEnabledInputSchema,
  type AutomationContract,
  type SetAutomationEnabledInput,
} from "../contracts/automation-contracts";
import type { AutomationRepo } from "./automation-repo";
import { automationToContract } from "./automation-contract-mapper";

/** `GET /projects/:projectId/automations`: every automation in the project, in key order. */
export const listAutomations = async (
  projectId: UuidV7,
  {
    userAuthz,
    automationRepo,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    automationRepo: AutomationRepo;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<AutomationContract[]> => {
  await userAuthz.requireProjectPermission({
    projectId,
    permission: "executions:read",
    dbExecutor,
  });
  const resolved = await automationRepo.listByProjectId(projectId, dbExecutor);
  return resolved.map(automationToContract);
};

/**
 * `POST /projects/:projectId/automations/:key/enable|disable`. Only project
 * automations can be enabled: a work-item automation is a `400`.
 */
export const setAutomationEnabled = async (
  input: SetAutomationEnabledInput,
  {
    userAuthz,
    automationRepo,
    timeProvider,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    automationRepo: AutomationRepo;
    timeProvider: TimeProvider;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<AutomationContract, ResourceNotFoundError | CoreError>> => {
  const { projectId, key, enabled } =
    setAutomationEnabledInputSchema.parse(input);
  await userAuthz.requireProjectPermission({
    projectId,
    permission: "pipelines:write",
    dbExecutor,
  });
  const automation = await automationRepo.findByKey(projectId, key, dbExecutor);
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
  const updated =
    automation.enabled === enabled
      ? automation
      : await automationRepo.update(
          automation.setEnabled(enabled, timeProvider.now()),
          dbExecutor,
        );
  return Result.ok(
    automationToContract({
      automation: updated,
      latestVersion: await automationRepo.loadLatestVersion(
        updated.id,
        dbExecutor,
      ),
    }),
  );
};

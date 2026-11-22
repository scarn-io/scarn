import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { CoreError, ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { WorkItemRepo } from "@scarn/core/work-items/work-item/application/work-item-repo";
import type { WorkItemEntity } from "@scarn/core/work-items/work-item/domain/work-item-entity";
import {
  parseWorkItemId,
  type WorkItemId,
} from "@scarn/core/work-items/work-item/domain/work-item-id";
import type { ProjectPermission } from "@scarn/core/projects/project/domain/project-permission";
import {
  workItemAutomationRefInputSchema,
  type WorkItemAutomationContract,
  type WorkItemAutomationRefInput,
} from "../contracts/automation-contracts";
import type { AutomationEntity } from "../domain/automation-entity";
import type { AutomationRepo } from "./automation-repo";
import type { WorkItemAutomationRepo } from "./work-item-automation-repo";
import { workItemAutomationToContract } from "./automation-contract-mapper";
import { attachAutomation } from "./attach-automation";
import type { SelfAttachedPort } from "./automation-runner";

type Deps = {
  userAuthz: UserAuthorizationService;
  workItemRepo: WorkItemRepo;
  automationRepo: AutomationRepo;
  workItemAutomationRepo: WorkItemAutomationRepo;
  dbExecutor?: DbExecutor | undefined;
};

const loadAuthorizedWorkItem = async (
  workItemId: WorkItemId,
  permission: ProjectPermission,
  { userAuthz, workItemRepo, dbExecutor }: Deps,
): Promise<Result<WorkItemEntity, ResourceNotFoundError>> => {
  const workItem = await workItemRepo.load(workItemId, dbExecutor);
  if (!workItem) {
    return Result.err(new ResourceNotFoundError("Work item", workItemId));
  }
  await userAuthz.requireProjectPermission({
    projectId: workItem.projectId,
    permission,
    dbExecutor,
  });
  return Result.ok(workItem);
};

const findAttachment = async (
  workItemId: WorkItemId,
  automationId: AutomationEntity["id"],
  deps: Deps,
): Promise<WorkItemAutomationContract | null> => {
  const attachments = await deps.workItemAutomationRepo.listByWorkItemId(
    workItemId,
    deps.dbExecutor,
  );
  const found = attachments.find(
    (entry) => entry.automation.id === automationId,
  );
  return found ? workItemAutomationToContract(found) : null;
};

/** `GET /work-items/:workItemId/automations`: the automations attached to a work item, in key order. */
export const listWorkItemAutomations = async (
  workItemId: WorkItemId,
  deps: Deps,
): Promise<Result<WorkItemAutomationContract[], ResourceNotFoundError>> => {
  const workItem = await loadAuthorizedWorkItem(
    parseWorkItemId(workItemId),
    "work-items:read",
    deps,
  );
  if (!workItem.ok) {
    return workItem;
  }
  const attachments = await deps.workItemAutomationRepo.listByWorkItemId(
    workItem.value.id,
    deps.dbExecutor,
  );
  return Result.ok(attachments.map(workItemAutomationToContract));
};

/**
 * `POST /work-items/:workItemId/automations/:key`: attach a work-item
 * automation. A new attachment fires `self.attached` for that automation
 * only, in the same transaction. Attaching again returns the existing
 * attachment and fires nothing. A project automation, or a closed work
 * item, is a `400`.
 */
export const attachWorkItemAutomation = async (
  input: WorkItemAutomationRefInput,
  deps: Deps & {
    timeProvider: TimeProvider;
    automationRunner: SelfAttachedPort;
  },
): Promise<
  Result<WorkItemAutomationContract, ResourceNotFoundError | CoreError>
> => {
  const { workItemId, key } = workItemAutomationRefInputSchema.parse(input);
  const workItem = await loadAuthorizedWorkItem(
    workItemId,
    "work-items:update",
    deps,
  );
  if (!workItem.ok) {
    return workItem;
  }
  const automation = await deps.automationRepo.findByKey(
    workItem.value.projectId,
    key,
    deps.dbExecutor,
  );
  if (!automation) {
    return Result.err(new ResourceNotFoundError("Automation", key));
  }
  if (automation.scope !== "workItem") {
    return Result.err(
      new CoreError({
        code: "AUTOMATION_NOT_WORK_ITEM_SCOPE",
        message: `'${key}' is a project automation; enable it instead of attaching it`,
        status: 400,
      }),
    );
  }
  if (workItem.value.state === "closed") {
    return Result.err(
      new CoreError({
        code: "WORK_ITEM_CLOSED",
        message: "Automations can't be attached to a closed work item",
        status: 400,
      }),
    );
  }
  await (deps.dbExecutor ?? getDb()).transaction(async (tx) => {
    const isNew = await attachAutomation(
      workItem.value,
      automation,
      {
        attachedByUserId: deps.userAuthz.actorId,
        attachedAt: deps.timeProvider.now(),
      },
      deps,
      tx,
    );
    if (isNew) {
      await deps.automationRunner.selfAttached(workItem.value, automation, tx);
    }
  });
  const attachment = await findAttachment(
    workItem.value.id,
    automation.id,
    deps,
  );
  if (!attachment) {
    return Result.err(new ResourceNotFoundError("Automation attachment", key));
  }
  return Result.ok(attachment);
};

/** `DELETE /work-items/:workItemId/automations/:key`: detach an automation. `404` when it isn't attached. */
export const detachWorkItemAutomation = async (
  input: WorkItemAutomationRefInput,
  deps: Deps,
): Promise<Result<{ detached: true }, ResourceNotFoundError>> => {
  const { workItemId, key } = workItemAutomationRefInputSchema.parse(input);
  const workItem = await loadAuthorizedWorkItem(
    workItemId,
    "work-items:update",
    deps,
  );
  if (!workItem.ok) {
    return workItem;
  }
  const automation = await deps.automationRepo.findByKey(
    workItem.value.projectId,
    key,
    deps.dbExecutor,
  );
  const deleted =
    automation !== null &&
    (await deps.workItemAutomationRepo.delete(
      workItem.value.id,
      automation.id,
      deps.dbExecutor,
    ));
  return deleted
    ? Result.ok({ detached: true })
    : Result.err(new ResourceNotFoundError("Automation attachment", key));
};

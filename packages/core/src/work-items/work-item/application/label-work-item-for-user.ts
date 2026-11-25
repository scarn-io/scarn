import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { CoreError, ResourceNotFoundError } from "@scarn/core/lib/errors";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UsernameReader } from "@scarn/core/organizations/organization/application/username-reader";
import { labelWorkItem } from "./label-work-item";
import { workItemEntityToContract } from "./work-item-contract-mapper";
import type { WorkItemEventsPort } from "./work-item-events-port";
import type { WorkItemRepo } from "./work-item-repo";
import {
  labelWorkItemInputSchema,
  type LabelWorkItemInput,
  type WorkItemContract,
} from "../contracts/work-item-contracts";
import { parseWorkItemId } from "../domain/work-item-id";

type LabelWorkItemForUserDeps = {
  userAuthz: UserAuthorizationService;
  workItemRepo: WorkItemRepo;
  workItemEvents: WorkItemEventsPort;
  usernameReader: UsernameReader;
  timeProvider: TimeProvider;
  dbExecutor?: DbExecutor | undefined;
};

/**
 * A project member adds and removes labels on a native work item. Synced
 * items are refused with a 409: their labels come from the tracker.
 */
export const labelWorkItemForUser = async (
  input: LabelWorkItemInput,
  deps: LabelWorkItemForUserDeps,
): Promise<WorkItemContract> => {
  const parsedInput = labelWorkItemInputSchema.parse(input);
  const workItemId = parseWorkItemId(parsedInput.workItemId);

  const run = async (tx: DbExecutor) => {
    const workItem = await deps.workItemRepo.load(workItemId, tx);
    if (!workItem) {
      throw new ResourceNotFoundError("Work item", workItemId);
    }

    await deps.userAuthz.requireProjectPermission({
      projectId: workItem.projectId,
      permission: "work-items:write",
      dbExecutor: tx,
    });

    if (workItem.platform !== "scarn") {
      throw new CoreError({
        code: "WORK_ITEM_NOT_NATIVE",
        message:
          "This work item was synced from an external source; its labels come from there",
        status: 409,
      });
    }

    const { workItem: labelled } = await labelWorkItem(
      workItem,
      { add: parsedInput.add, remove: parsedInput.remove },
      deps,
      tx,
    );
    return labelled;
  };

  const persisted = deps.dbExecutor
    ? await run(deps.dbExecutor)
    : await getDb().transaction(async (tx) => await run(tx));

  const creatorsByUserId = await deps.usernameReader.loadUsernamesByUserId(
    persisted.createdByUserId === null ? [] : [persisted.createdByUserId],
    deps.dbExecutor,
  );
  const creator = persisted.createdByUserId
    ? creatorsByUserId.get(persisted.createdByUserId)
    : undefined;

  return workItemEntityToContract(
    persisted,
    creator?.username ?? null,
    creator?.image ?? null,
  );
};

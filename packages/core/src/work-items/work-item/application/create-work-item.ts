import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@scarn/core/lib/db";
import {
  InvariantViolationError,
  PersistenceError,
  ResourceConflictError,
} from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import {
  workItemEntityToContract,
  upsertWorkItemInputToCreateWorkItemProps,
} from "./work-item-contract-mapper";
import {
  createWorkItemInputSchema,
  upsertWorkItemsInputSchema,
  type CreateWorkItemRequestInput,
  type WorkItemContract,
  type UpsertWorkItemsInput,
} from "../contracts/work-item-contracts";
import { WorkItemEntity } from "../domain/work-item-entity";
import type { WorkItemId } from "../domain/work-item-id";
import type { WorkItemPlatform } from "../domain/work-item-platform";
import type { WorkItemEventsPort } from "./work-item-events-port";
import type { WorkItemRepo } from "./work-item-repo";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";

const getWorkItemSourceIdentity = (workItem: {
  projectId: UuidV7;
  platform: WorkItemPlatform;
  platformKey: string;
}) => ({
  projectId: workItem.projectId,
  platform: workItem.platform,
  sourceIdentity: workItem.platformKey,
});

const toSourceIdentityKey = (workItem: {
  projectId: UuidV7;
  platform: WorkItemPlatform;
  sourceIdentity: string;
}) => `${workItem.projectId}:${workItem.platform}:${workItem.sourceIdentity}`;

const toDisplaySourceIdentityKey = (workItem: {
  platform: WorkItemPlatform;
  sourceIdentity: string;
}) => `${workItem.platform}:${workItem.sourceIdentity}`;

/**
 * What an agent Task's create sets that a person's can't: the id the worker
 * made, the parent (the Task's item, or none for a top-level item in the
 * project) and the Task that spawned it.
 */
export type SpawnedWorkItemProps = {
  id: WorkItemId;
  parentWorkItemId: WorkItemId | null;
  spawnedByTaskId: UuidV7;
};

const buildCreateWorkItem = (
  input: UpsertWorkItemsInput[number],
  now: Date,
  createdByUserId: UuidV7,
  spawned: Partial<SpawnedWorkItemProps> | undefined,
): WorkItemEntity => {
  const createWorkItemProps = upsertWorkItemInputToCreateWorkItemProps(input);

  return WorkItemEntity.rehydrate({
    ...WorkItemEntity.create({
      ...createWorkItemProps,
      ...spawned,
      createdByUserId,
    }).toJSON(),
    createdAt: now,
    updatedAt: now,
  });
};

const makeWorkItemConflict = (
  sourceIdentityKey: string,
): ResourceConflictError => {
  return new ResourceConflictError("work item", sourceIdentityKey);
};

export type CreateWorkItemsDeps = {
  userAuthz: UserAuthorizationService;
  workItemRepo: WorkItemRepo;
  timeProvider: TimeProvider;
  workItemEvents: WorkItemEventsPort;
  dbExecutor?: DbExecutor | undefined;
};

const requireCreateWorkItemsProjectPermission = async (
  input: UpsertWorkItemsInput,
  { userAuthz, dbExecutor }: CreateWorkItemsDeps,
): Promise<void> => {
  const projectIds = [
    ...new Set(
      upsertWorkItemsInputSchema
        .parse(input)
        .map((workItem) => workItem.projectId),
    ),
  ];

  for (const projectId of projectIds) {
    await userAuthz.requireProjectPermission({
      projectId,
      permission: "work-items:create",
      dbExecutor,
    });
  }
};

const executeCreateWorkItems = async (
  input: UpsertWorkItemsInput,
  deps: CreateWorkItemsDeps,
  spawned: Partial<SpawnedWorkItemProps>[] | undefined,
): Promise<Result<WorkItemContract[], ResourceConflictError>> => {
  const { userAuthz, workItemRepo, timeProvider, dbExecutor } = deps;
  const parsedInput = upsertWorkItemsInputSchema.parse(input);
  const seenSourceIdentities = new Set<string>();

  for (const workItem of parsedInput) {
    const sourceIdentityKey = toSourceIdentityKey(
      getWorkItemSourceIdentity(workItem),
    );
    if (seenSourceIdentities.has(sourceIdentityKey)) {
      return Result.err(
        makeWorkItemConflict(
          toDisplaySourceIdentityKey(getWorkItemSourceIdentity(workItem)),
        ),
      );
    }
    seenSourceIdentities.add(sourceIdentityKey);
  }

  const existingWorkItems = await workItemRepo.loadManyByPlatformIdentities(
    parsedInput.map((workItem) => getWorkItemSourceIdentity(workItem)),
    dbExecutor,
  );

  const existingWorkItem =
    existingWorkItems.length > 0 ? existingWorkItems[0] : null;
  if (existingWorkItem) {
    return Result.err(
      makeWorkItemConflict(
        toDisplaySourceIdentityKey(getWorkItemSourceIdentity(existingWorkItem)),
      ),
    );
  }

  const now = timeProvider.now();
  const createCandidates = parsedInput.map((workItem, index) =>
    buildCreateWorkItem(workItem, now, userAuthz.actorId, spawned?.[index]),
  );
  const persistedWorkItems = await workItemRepo.createMany(
    createCandidates,
    dbExecutor,
  );
  const createdIds = persistedWorkItems.map((workItem) =>
    parseUuidV7(workItem.id),
  );
  if (createdIds.length > 0) {
    const tx = dbExecutor ?? getDb();
    await deps.workItemEvents.created(createdIds, tx);
    for (const workItem of persistedWorkItems) {
      if (workItem.labels.length > 0) {
        await deps.workItemEvents.labelsAdded(
          parseUuidV7(workItem.id),
          [...workItem.labels],
          tx,
        );
      }
    }
    await deps.workItemEvents.mayHaveBecomeReady(createdIds, tx);
  }
  const persistedWorkItemBySourceIdentity = new Map(
    persistedWorkItems.map((workItem) => [
      toSourceIdentityKey(getWorkItemSourceIdentity(workItem)),
      workItem,
    ]),
  );
  const missingSourceIdentities = parsedInput
    .map((workItem) => getWorkItemSourceIdentity(workItem))
    .filter(
      (identity) =>
        !persistedWorkItemBySourceIdentity.has(toSourceIdentityKey(identity)),
    );

  if (missingSourceIdentities.length > 0) {
    const conflictingWorkItems =
      await workItemRepo.loadManyByPlatformIdentities(
        missingSourceIdentities,
        dbExecutor,
      );

    const conflictingWorkItem =
      conflictingWorkItems.length > 0 ? conflictingWorkItems[0] : null;
    if (conflictingWorkItems.length > 0) {
      if (!conflictingWorkItem) {
        throw new PersistenceError(
          "Conflicting work item lookup returned no work item",
          "WORK_ITEM_CONFLICT_LOOKUP_FAILED",
        );
      }

      return Result.err(
        makeWorkItemConflict(
          toDisplaySourceIdentityKey(
            getWorkItemSourceIdentity(conflictingWorkItem),
          ),
        ),
      );
    }
  }

  const contracts: WorkItemContract[] = [];
  for (const workItem of parsedInput) {
    const sourceIdentityKey = toSourceIdentityKey(
      getWorkItemSourceIdentity(workItem),
    );
    const persistedWorkItem =
      persistedWorkItemBySourceIdentity.get(sourceIdentityKey);

    if (!persistedWorkItem) {
      throw new PersistenceError(
        `Failed to persist work item ${sourceIdentityKey}`,
        "WORK_ITEM_PERSIST_FAILED",
      );
    }

    contracts.push(workItemEntityToContract(persistedWorkItem));
  }
  return Result.ok(contracts);
};

/**
 * Creates work items. `spawned`, when given, lines up with `input` by index:
 * an agent Task's creates carry the id, parent and spawning Task for each.
 * Tells `workItemEvents` the items were created, the labels they were
 * created with, and that they may be ready.
 */
export const createWorkItems = async (
  input: UpsertWorkItemsInput,
  deps: CreateWorkItemsDeps,
  spawned?: SpawnedWorkItemProps[],
): Promise<Result<WorkItemContract[], ResourceConflictError>> => {
  if (spawned && spawned.length !== input.length) {
    throw new InvariantViolationError(
      "Every spawned work item needs its own spawn props",
      "SPAWNED_WORK_ITEM_PROPS_MISMATCH",
    );
  }
  await requireCreateWorkItemsProjectPermission(input, deps);
  return await executeCreateWorkItems(input, deps, spawned);
};

/**
 * Creates one work item. A person may give the id (`input.id`), the way an
 * agent Task's creates do, so a native item's `platformKey` can name it.
 */
export const createWorkItem = async (
  input: CreateWorkItemRequestInput,
  deps: CreateWorkItemsDeps,
): Promise<Result<WorkItemContract, ResourceConflictError>> => {
  const { id, ...workItem } = createWorkItemInputSchema.parse(input);
  await requireCreateWorkItemsProjectPermission([workItem], deps);
  if (id && (await deps.workItemRepo.load(id, deps.dbExecutor))) {
    return Result.err(makeWorkItemConflict(id));
  }
  const listResult = await executeCreateWorkItems(
    [workItem],
    deps,
    id ? [{ id }] : undefined,
  );
  if (!listResult.ok) return listResult;

  const result = listResult.value[0];
  if (!result) {
    throw new InvariantViolationError(
      "Created work item not found in result",
      "CREATED_WORK_ITEM_MISSING",
    );
  }

  return Result.ok(result);
};

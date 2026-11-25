import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  InvariantViolationError,
  PersistenceError,
} from "@scarn/core/lib/errors";
import {
  workItemEntityToContract,
  upsertWorkItemInputToCreateWorkItemProps,
} from "./work-item-contract-mapper";
import {
  upsertWorkItemsInputSchema,
  type WorkItemContract,
  type UpsertWorkItemInput,
  type UpsertWorkItemsInput,
} from "../contracts/work-item-contracts";
import { WorkItemEntity } from "../domain/work-item-entity";
import type { WorkItemPlatform } from "../domain/work-item-platform";
import {
  setWorkItemState,
  type SetWorkItemStateDeps,
} from "./set-work-item-state";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";

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

const buildUpsertWorkItem = (
  input: UpsertWorkItemsInput[number],
  now: Date,
  createdByUserId: UuidV7,
): WorkItemEntity => {
  const createWorkItemProps = upsertWorkItemInputToCreateWorkItemProps(input);

  return WorkItemEntity.rehydrate({
    ...WorkItemEntity.create({
      ...createWorkItemProps,
      createdByUserId,
    }).toJSON(),
    createdAt: now,
    updatedAt: now,
  });
};

export type UpsertWorkItemsDeps = SetWorkItemStateDeps & {
  userAuthz: UserAuthorizationService;
};

/**
 * The upsert never changes an existing item's state, so a close or reopen
 * reported by the source is handed to `setWorkItemState` here. New items were
 * inserted with their incoming state and need nothing more.
 *
 * Without a caller's transaction, each `setWorkItemState` call opens its own,
 * so a state change and the readiness it causes land together even though
 * the upsert's field writes before it are not part of that transaction.
 */
const applySyncedStateChanges = async (
  saved: WorkItemEntity[],
  incoming: WorkItemEntity[],
  existingBySourceIdentity: Map<string, WorkItemEntity>,
  deps: UpsertWorkItemsDeps,
): Promise<WorkItemEntity[]> => {
  const incomingStateBySourceIdentity = new Map(
    incoming.map((workItem) => [
      toSourceIdentityKey(getWorkItemSourceIdentity(workItem)),
      workItem.state,
    ]),
  );
  const toClose: WorkItemEntity[] = [];
  const toReopen: WorkItemEntity[] = [];
  for (const workItem of saved) {
    const key = toSourceIdentityKey(getWorkItemSourceIdentity(workItem));
    const incomingState = incomingStateBySourceIdentity.get(key);
    if (
      !existingBySourceIdentity.has(key) ||
      incomingState === workItem.state
    ) {
      continue;
    }
    (incomingState === "closed" ? toClose : toReopen).push(workItem);
  }

  const changed = [
    ...(await setWorkItemState(
      toClose,
      {
        state: "closed",
        reason: "completed",
        resolution: null,
        closedByUserId: null,
      },
      deps,
    )),
    ...(await setWorkItemState(toReopen, { state: "open" }, deps)),
  ];
  const changedById = new Map(
    changed.map((workItem) => [workItem.id, workItem]),
  );

  return saved.map((workItem) => changedById.get(workItem.id) ?? workItem);
};

export type UpsertWorkItemsOptions = {
  /**
   * Only update an existing item when the incoming `sourceUpdatedAt` is
   * strictly newer than the stored one (see
   * `WorkItemRepo.saveManyIfSourceNewer`). Items the guard rejects are left
   * untouched and are left out of the result, so a shorter result means some
   * inputs were stale no-ops.
   */
  onlyIfSourceNewer?: boolean;
};

const requireUpsertWorkItemsProjectPermission = async (
  input: UpsertWorkItemsInput,
  { userAuthz, dbExecutor }: UpsertWorkItemsDeps,
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
      permission: "work-items:write",
      dbExecutor,
    });
  }
};

/**
 * Tells `workItemEvents` about the rows the upsert created (and that they
 * may be ready), then the labels each persisted item gained against its
 * stored row (every label, for a new one). Sync replaces the whole label
 * list, so this diff is where `labelsAdded` comes from.
 */
const tellWorkItemEvents = async (
  persisted: WorkItemEntity[],
  existingBySourceIdentity: Map<string, WorkItemEntity>,
  deps: UpsertWorkItemsDeps,
  tx: DbExecutor,
): Promise<void> => {
  const createdIds = persisted
    .filter(
      (workItem) =>
        !existingBySourceIdentity.has(
          toSourceIdentityKey(getWorkItemSourceIdentity(workItem)),
        ),
    )
    .map((workItem) => parseUuidV7(workItem.id));
  if (createdIds.length > 0) {
    await deps.workItemEvents.created(createdIds, tx);
  }
  for (const workItem of persisted) {
    const previousLabels = new Set(
      existingBySourceIdentity.get(
        toSourceIdentityKey(getWorkItemSourceIdentity(workItem)),
      )?.labels ?? [],
    );
    const addedLabels = workItem.labels.filter(
      (label) => !previousLabels.has(label),
    );
    if (addedLabels.length > 0) {
      await deps.workItemEvents.labelsAdded(
        parseUuidV7(workItem.id),
        addedLabels,
        tx,
      );
    }
  }
  if (createdIds.length > 0) {
    await deps.workItemEvents.mayHaveBecomeReady(createdIds, tx);
  }
};

const executeUpsertWorkItems = async (
  input: UpsertWorkItemsInput,
  deps: UpsertWorkItemsDeps,
  options: UpsertWorkItemsOptions,
): Promise<WorkItemContract[]> => {
  const { userAuthz, workItemRepo, timeProvider, dbExecutor } = deps;
  const parsedInput = upsertWorkItemsInputSchema.parse(input);
  const now = timeProvider.now();
  const upsertCandidates = parsedInput.map((workItem) =>
    buildUpsertWorkItem(workItem, now, userAuthz.actorId),
  );
  const dedupedWorkItems = Array.from(
    new Map(
      upsertCandidates.map((workItem) => [
        toSourceIdentityKey(getWorkItemSourceIdentity(workItem)),
        workItem,
      ]),
    ).values(),
  );
  const inputsWithLabels = new Set(
    Array.from(
      new Map(
        parsedInput.map((workItem) => [
          toSourceIdentityKey(getWorkItemSourceIdentity(workItem)),
          workItem.labels !== undefined,
        ]),
      ),
    )
      .filter(([, hasLabels]) => hasLabels)
      .map(([key]) => key),
  );
  const existingWorkItems = await workItemRepo.loadManyByPlatformIdentities(
    dedupedWorkItems.map((workItem) => getWorkItemSourceIdentity(workItem)),
    dbExecutor,
  );
  const existingWorkItemsBySourceIdentity = new Map(
    existingWorkItems.map((workItem) => [
      toSourceIdentityKey(getWorkItemSourceIdentity(workItem)),
      workItem,
    ]),
  );
  // Ingestion payloads have no concept of Scarn's parent/child hierarchy
  // (Decision 10 in `docs/work-item-relationships-plan.md`), so carry each
  // existing item's `parentWorkItemId` forward onto its upsert candidate
  // before persisting — otherwise re-syncing from GitHub/Jira/Linear would
  // silently clear a relationship a user set through the product. New items
  // have no existing row, so they correctly stay parentless. An input that
  // leaves `labels` out keeps the existing item's labels the same way.
  const dedupedWorkItemsWithPreservedParent = dedupedWorkItems.map(
    (workItem) => {
      const key = toSourceIdentityKey(getWorkItemSourceIdentity(workItem));
      const existing = existingWorkItemsBySourceIdentity.get(key);

      return existing
        ? WorkItemEntity.rehydrate({
            ...workItem.toJSON(),
            parentWorkItemId: existing.parentWorkItemId,
            labels: inputsWithLabels.has(key)
              ? workItem.labels
              : existing.labels,
          })
        : workItem;
    },
  );
  const savedWorkItems = options.onlyIfSourceNewer
    ? await workItemRepo.saveManyIfSourceNewer(
        dedupedWorkItemsWithPreservedParent,
        dbExecutor,
      )
    : await workItemRepo.saveMany(
        dedupedWorkItemsWithPreservedParent,
        dbExecutor,
      );
  const persistedWorkItems = await applySyncedStateChanges(
    savedWorkItems,
    dedupedWorkItemsWithPreservedParent,
    existingWorkItemsBySourceIdentity,
    deps,
  );
  await tellWorkItemEvents(
    persistedWorkItems,
    existingWorkItemsBySourceIdentity,
    deps,
    dbExecutor ?? getDb(),
  );
  const persistedWorkItemBySourceIdentity = new Map(
    persistedWorkItems.map((workItem) => [
      toSourceIdentityKey(getWorkItemSourceIdentity(workItem)),
      workItem,
    ]),
  );

  return parsedInput.flatMap((workItem) => {
    const sourceIdentityKey = toSourceIdentityKey(
      getWorkItemSourceIdentity(workItem),
    );
    const persistedWorkItem =
      persistedWorkItemBySourceIdentity.get(sourceIdentityKey);

    if (persistedWorkItem) {
      return [workItemEntityToContract(persistedWorkItem)];
    }

    if (options.onlyIfSourceNewer) {
      return [];
    }

    throw new PersistenceError(
      `Failed to persist work item ${sourceIdentityKey}`,
      "WORK_ITEM_PERSIST_FAILED",
    );
  });
};

/**
 * The one front door for sync writes to work items: every integration path
 * (poll sync, the GitHub issue webhook, the bulk upsert API) persists through
 * here, so the work item events (created, labels added, readiness; closes and
 * reopens through `setWorkItemState`) fire once for every write.
 */
export const upsertWorkItems = async (
  input: UpsertWorkItemsInput,
  deps: UpsertWorkItemsDeps,
  options: UpsertWorkItemsOptions = {},
): Promise<WorkItemContract[]> => {
  await requireUpsertWorkItemsProjectPermission(input, deps);
  return await executeUpsertWorkItems(input, deps, options);
};

export const upsertWorkItem = async (
  input: UpsertWorkItemInput,
  deps: UpsertWorkItemsDeps,
): Promise<WorkItemContract> => {
  const resultArr = await upsertWorkItems([input], deps);

  const result = resultArr[0];
  if (!result) {
    throw new InvariantViolationError(
      "Upserted work item not found in result",
      "UPSERTED_WORK_ITEM_MISSING",
    );
  }

  return result;
};

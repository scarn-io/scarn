import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  CoreError,
  InvariantViolationError,
  ResourceNotFoundError,
} from "@scarn/core/lib/errors";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UsernameReader } from "@scarn/core/organizations/organization/application/username-reader";
import type { WorkItemCommentRepo } from "@scarn/core/work-items/work-item-comment/application/work-item-comment-repo";
import { WorkItemCommentEntity } from "@scarn/core/work-items/work-item-comment/domain/work-item-comment-entity";
import type { WorkItemBlockRepo } from "@scarn/core/work-items/work-item-block/application/work-item-block-repo";
import type { WorkItemEventsPort } from "./work-item-events-port";
import { workItemEntityToContract } from "./work-item-contract-mapper";
import type { WorkItemRepo } from "./work-item-repo";
import {
  setWorkItemStateInputSchema,
  type SetWorkItemStateInput,
  type WorkItemContract,
} from "../contracts/work-item-contracts";
import type { WorkItemCloseReason } from "../domain/work-item-close-reason";
import type { WorkItemEntity } from "../domain/work-item-entity";
import { parseWorkItemId } from "../domain/work-item-id";

/**
 * A close or reopen. A person's close sets `closedByUserId`, an agent Task's
 * close `closedByTaskId`; a sync close sets neither and carries no
 * resolution.
 */
export type WorkItemStateChange =
  | {
      state: "closed";
      reason: WorkItemCloseReason;
      resolution: string | null;
      closedByUserId: UuidV7 | null;
      closedByTaskId?: UuidV7 | null | undefined;
    }
  | { state: "open" };

export type SetWorkItemStateDeps = {
  workItemRepo: WorkItemRepo;
  workItemBlockRepo: WorkItemBlockRepo;
  workItemEvents: WorkItemEventsPort;
  /** Needed only to post a close's resolution as a comment. */
  workItemCommentRepo?: WorkItemCommentRepo | undefined;
  timeProvider: TimeProvider;
  dbExecutor?: DbExecutor | undefined;
};

const postResolutionComments = async (
  closed: WorkItemEntity[],
  deps: SetWorkItemStateDeps,
): Promise<void> => {
  for (const workItem of closed) {
    const closure = workItem.closure;
    if (!closure?.resolution) {
      continue;
    }
    if (
      (!closure.closedByUserId && !closure.closedByTaskId) ||
      !deps.workItemCommentRepo
    ) {
      throw new InvariantViolationError(
        "A resolution comment needs a closer and a comment repo",
        "WORK_ITEM_RESOLUTION_COMMENT_UNPOSTABLE",
      );
    }

    const workItemId = parseUuidV7(workItem.id);
    await deps.workItemCommentRepo.create(
      closure.closedByUserId
        ? WorkItemCommentEntity.rehydrate({
            ...WorkItemCommentEntity.create({
              projectId: workItem.projectId,
              workItemId,
              authorUserId: closure.closedByUserId,
              body: closure.resolution,
            }).toJSON(),
            createdAt: closure.closedAt,
            updatedAt: closure.closedAt,
          })
        : WorkItemCommentEntity.createAgentComment({
            projectId: workItem.projectId,
            workItemId,
            authoredByTaskId: closure.closedByTaskId,
            body: closure.resolution,
            createdAt: closure.closedAt,
          }),
      deps.dbExecutor,
    );
  }
};

/**
 * The one front door for closing and reopening work items: people, sync
 * (through `upsertWorkItems`) and, later, agents all change state here.
 * Throws if an item is already in the requested state. Runs in the caller's
 * transaction, or its own when given none.
 *
 * Tells `workItemEvents`, in the same transaction, about the items that
 * closed, and that the reopened items and the items the changed ones were
 * blocking may have become ready. Returns the items whose state actually
 * changed.
 */
export const setWorkItemState = async (
  workItems: WorkItemEntity[],
  change: WorkItemStateChange,
  deps: SetWorkItemStateDeps,
): Promise<WorkItemEntity[]> => {
  if (workItems.length === 0) {
    return [];
  }
  if (!deps.dbExecutor) {
    return await getDb().transaction(
      async (tx) =>
        await setWorkItemState(workItems, change, { ...deps, dbExecutor: tx }),
    );
  }
  const tx = deps.dbExecutor;

  const now = deps.timeProvider.now();
  const changed = workItems.map((workItem) =>
    change.state === "closed"
      ? workItem.close(
          {
            reason: change.reason,
            resolution: change.resolution?.trim() || null,
            closedAt: now,
            closedByUserId: change.closedByUserId,
            closedByTaskId: change.closedByTaskId ?? null,
          },
          now,
        )
      : workItem.reopen(now),
  );

  const persisted = await deps.workItemRepo.setStateMany(changed, tx);
  const persistedIds = persisted.map((workItem) => parseUuidV7(workItem.id));
  if (change.state === "closed") {
    await postResolutionComments(persisted, deps);
    if (persistedIds.length > 0) {
      await deps.workItemEvents.closed(persistedIds, tx);
    }
  }

  const dependents = await deps.workItemBlockRepo.listIdsBlockedBy(
    persistedIds,
    tx,
  );
  await deps.workItemEvents.mayHaveBecomeReady(
    change.state === "open" ? [...persistedIds, ...dependents] : dependents,
    tx,
  );

  return persisted;
};

export type SetWorkItemStateForUserDeps = {
  userAuthz: UserAuthorizationService;
  workItemRepo: WorkItemRepo;
  workItemBlockRepo: WorkItemBlockRepo;
  workItemEvents: WorkItemEventsPort;
  workItemCommentRepo: WorkItemCommentRepo;
  usernameReader: UsernameReader;
  timeProvider: TimeProvider;
  dbExecutor?: DbExecutor | undefined;
};

/**
 * A person closing or reopening one work item. Synced items can be closed
 * here too: the close is Scarn-side, and the next sync that reports a
 * different state wins.
 */
export const setWorkItemStateForUser = async (
  input: SetWorkItemStateInput,
  deps: SetWorkItemStateForUserDeps,
): Promise<WorkItemContract> => {
  const parsedInput = setWorkItemStateInputSchema.parse(input);
  const workItemId = parseWorkItemId(parsedInput.workItemId);

  const run = async (tx: DbExecutor): Promise<WorkItemEntity> => {
    const workItem = await deps.workItemRepo.load(workItemId, tx);
    if (!workItem) {
      throw new ResourceNotFoundError("Work item", workItemId);
    }

    await deps.userAuthz.requireProjectPermission({
      projectId: workItem.projectId,
      permission: "work-items:write",
      dbExecutor: tx,
    });

    const [persisted] = await setWorkItemState(
      [workItem],
      parsedInput.state === "closed"
        ? {
            state: "closed",
            reason: parsedInput.reason,
            resolution: parsedInput.resolution ?? null,
            closedByUserId: deps.userAuthz.actorId,
          }
        : { state: "open" },
      { ...deps, dbExecutor: tx },
    );
    if (!persisted) {
      throw new CoreError({
        code: "WORK_ITEM_STATE_CONFLICT",
        message: "The work item's state changed while this request ran",
        status: 409,
      });
    }

    return persisted;
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

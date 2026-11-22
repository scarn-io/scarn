import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import { DeferredWorkItemEvents } from "@scarn/core/work-items/work-item/application/deferred-work-item-events";
import { describeWorkItemByTask } from "@scarn/core/work-items/work-item/application/describe-work-item-by-task";
import { labelWorkItem } from "@scarn/core/work-items/work-item/application/label-work-item";
import { setWorkItemState } from "@scarn/core/work-items/work-item/application/set-work-item-state";
import type { WorkItemEventsPort } from "@scarn/core/work-items/work-item/application/work-item-events-port";
import type { WorkItemRepo } from "@scarn/core/work-items/work-item/application/work-item-repo";
import { parseWorkItemId } from "@scarn/core/work-items/work-item/domain/work-item-id";
import type { WorkItemEntity } from "@scarn/core/work-items/work-item/domain/work-item-entity";
import type { WorkItemBlockRepo } from "@scarn/core/work-items/work-item-block/application/work-item-block-repo";
import { createWorkItemBlock } from "@scarn/core/work-items/work-item-block/application/create-work-item-block";
import { deleteWorkItemBlock } from "@scarn/core/work-items/work-item-block/application/delete-work-item-block";
import type { WorkItemCommentRepo } from "@scarn/core/work-items/work-item-comment/application/work-item-comment-repo";
import { WorkItemCommentEntity } from "@scarn/core/work-items/work-item-comment/domain/work-item-comment-entity";
import { CoreValidationError } from "@scarn/core/lib/errors";
import type { WorkItemChange } from "../contracts/work-item-change-contracts";
import type { TaskEntity } from "../domain/task-entity";
import type { TaskRepo } from "./task-repo";
import {
  validateWorkItemChanges,
  WORK_ITEM_CHANGES_INVALID,
} from "./validate-work-item-changes";

export type ApplyWorkItemChangesDeps = {
  /** The completing worker's actor: the front doors check its permissions. */
  userAuthz: UserAuthorizationService;
  taskRepo: TaskRepo;
  workItemRepo: WorkItemRepo;
  workItemBlockRepo: WorkItemBlockRepo;
  workItemEvents: WorkItemEventsPort;
  workItemCommentRepo: WorkItemCommentRepo;
  timeProvider: TimeProvider;
};

type ChangeOf<K extends WorkItemChange["kind"]> = Extract<
  WorkItemChange,
  { kind: K }
>;

const ofKind = <K extends WorkItemChange["kind"]>(
  changes: WorkItemChange[],
  kind: K,
): ChangeOf<K>[] =>
  changes.filter((change): change is ChangeOf<K> => change.kind === kind);

const loadExisting = async (
  workItemId: string,
  deps: ApplyWorkItemChangesDeps,
  tx: DbExecutor,
): Promise<WorkItemEntity> => {
  const workItem = await deps.workItemRepo.load(
    parseWorkItemId(workItemId),
    tx,
  );
  if (!workItem) {
    throw new CoreValidationError(
      `Work item ${workItemId} doesn't exist`,
      WORK_ITEM_CHANGES_INVALID,
    );
  }
  return workItem;
};

const applyLabels = async (
  labels: ChangeOf<"label">[],
  deps: ApplyWorkItemChangesDeps,
  tx: DbExecutor,
): Promise<void> => {
  for (const change of labels) {
    await labelWorkItem(
      await loadExisting(change.workItemId, deps, tx),
      { add: change.add, remove: change.remove },
      deps,
      tx,
    );
  }
};

const applyBlocks = async (
  blocks: ChangeOf<"block">[],
  deps: ApplyWorkItemChangesDeps,
  tx: DbExecutor,
): Promise<void> => {
  for (const block of blocks) {
    if (!block.remove) {
      await createWorkItemBlock(
        {
          blockedWorkItemId: block.blockedWorkItemId,
          blockingWorkItemId: block.blockingWorkItemId,
        },
        { ...deps, dbExecutor: tx },
      );
      continue;
    }
    const existing = await deps.workItemBlockRepo.loadByPair(
      parseUuidV7(block.blockedWorkItemId),
      parseUuidV7(block.blockingWorkItemId),
      tx,
    );
    if (!existing) {
      throw new CoreValidationError(
        `Work item ${block.blockingWorkItemId} doesn't block ${block.blockedWorkItemId}`,
        WORK_ITEM_CHANGES_INVALID,
      );
    }
    await deleteWorkItemBlock(existing.id, { ...deps, dbExecutor: tx });
  }
};

/** Description writes and comments, in the order the agent made them. */
const applyWritesAndComments = async (
  task: TaskEntity,
  changes: WorkItemChange[],
  deps: ApplyWorkItemChangesDeps,
  tx: DbExecutor,
): Promise<void> => {
  for (const change of changes) {
    if (change.kind === "describe") {
      await describeWorkItemByTask(
        await loadExisting(change.workItemId, deps, tx),
        {
          description: change.description,
          expectedVersion: change.descriptionVersion,
        },
        deps,
        tx,
      );
    } else if (change.kind === "comment") {
      await deps.workItemCommentRepo.create(
        WorkItemCommentEntity.createAgentComment({
          projectId: task.projectId,
          workItemId: parseUuidV7(change.workItemId),
          authoredByTaskId: task.id,
          body: change.body,
          createdAt: deps.timeProvider.now(),
        }),
        tx,
      );
    }
  }
};

const applyCloses = async (
  task: TaskEntity,
  closes: ChangeOf<"close">[],
  deps: ApplyWorkItemChangesDeps,
  tx: DbExecutor,
): Promise<void> => {
  for (const close of closes) {
    await setWorkItemState(
      [await loadExisting(close.workItemId, deps, tx)],
      {
        state: "closed",
        reason: close.reason,
        resolution: close.resolution ?? null,
        closedByUserId: null,
        closedByTaskId: task.id,
      },
      { ...deps, dbExecutor: tx },
    );
  }
};

/**
 * Applies an agent Task's work item changes in `tx`, the completion's, through
 * the work item front doors: label changes, then blocks, then
 * description writes and comments, then closes. Validates every change
 * first (`validateWorkItemChanges`); any change that fails throws, and the
 * caller rolls back the lot.
 *
 * The front doors' work item events are held back and told to
 * `deps.workItemEvents` once every change has applied, so the listener sees
 * the final state. The order is `DeferredWorkItemEvents.flush`'s: each
 * `labelsAdded`, `closed`, then one deduplicated `mayHaveBecomeReady`.
 */
export const applyWorkItemChanges = async (
  task: TaskEntity,
  changes: WorkItemChange[],
  applyDeps: ApplyWorkItemChangesDeps,
  tx: DbExecutor,
): Promise<void> => {
  const workItemEvents = new DeferredWorkItemEvents(applyDeps.workItemEvents);
  const deps = { ...applyDeps, workItemEvents };
  await validateWorkItemChanges(task, changes, deps, tx);

  await applyLabels(ofKind(changes, "label"), deps, tx);
  await applyBlocks(ofKind(changes, "block"), deps, tx);
  await applyWritesAndComments(task, changes, deps, tx);
  await applyCloses(task, ofKind(changes, "close"), deps, tx);
  await workItemEvents.flush(tx);
};

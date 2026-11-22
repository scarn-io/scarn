import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { WorkItemBlockEntity } from "../domain/work-item-block-entity";
import type { WorkItemBlockId } from "../domain/work-item-block-id";

export type WorkItemBlockRepo = {
  create(
    block: WorkItemBlockEntity,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemBlockEntity>;
  load(
    id: WorkItemBlockId,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemBlockEntity | null>;
  /**
   * All rows where `workItemId` appears on either side (blocked or blocking).
   */
  listByWorkItem(
    workItemId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemBlockEntity[]>;
  /**
   * The row for a specific directed pair, if one exists. Used to detect a
   * direct 2-cycle (the reciprocal of a candidate edge already exists).
   */
  loadByPair(
    blockedWorkItemId: UuidV7,
    blockingWorkItemId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemBlockEntity | null>;
  /**
   * True when `toWorkItemId` is reachable from `fromWorkItemId` by following
   * existing `work_item_blocks` edges forward (blocked item -> its blocker ->
   * that blocker's blocker...), scoped to `projectId`. Used by
   * `createWorkItemBlock` to detect a would-be 3+-node cycle: called with
   * the candidate edge's `blockingWorkItemId` as `fromWorkItemId` and its
   * `blockedWorkItemId` as `toWorkItemId` — see the call site's comment for
   * why the arguments are in that order. Delegates to the recursive-CTE query
   * in `infra/work-item-block-reachability-subquery.ts` — kept behind this
   * repo method (rather than called directly from `application/`) so
   * `application/` never depends on `infra/` directly, per `docs/ddd.md`'s
   * dependency direction.
   */
  isReachable(
    projectId: UuidV7,
    fromWorkItemId: UuidV7,
    toWorkItemId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<boolean>;
  /** The given items that have at least one open blocker: the not-ready ones. */
  listIdsWithOpenBlockers(
    workItemIds: UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<UuidV7[]>;
  /**
   * Each given item's open blockers' ids, in one query. Items with no open
   * blocker have no entry.
   */
  listOpenBlockerIdsByBlocked(
    workItemIds: UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<Map<UuidV7, UuidV7[]>>;
  /** The items any of `blockingWorkItemIds` blocks, each once. */
  listIdsBlockedBy(
    blockingWorkItemIds: UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<UuidV7[]>;
  delete(id: WorkItemBlockId, dbExecutor?: DbExecutor): Promise<number>;
};

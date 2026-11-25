import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { PipelineRunStatus } from "@scarn/core/pipeline-executions/pipeline-run/domain/pipeline-run-entity";
import type {
  WorkItemAgentFilter,
  WorkItemTaskStatusCounts,
  WorkItemTimeBound,
} from "../contracts/work-item-contracts";
import type { WorkItemEntity } from "../domain/work-item-entity";
import type { WorkItemId } from "../domain/work-item-id";
import type { WorkItemPlatform } from "../domain/work-item-platform";
import type { WorkItemProjectionFingerprintEntity } from "../domain/work-item-projection-fingerprint-entity";

export type WorkItemListFieldFilter = {
  key: string;
  value: string;
};

export type WorkItemListSignalSort = {
  kind: "score";
  pipelineDefinitionId: UuidV7;
  stepKey: string;
  signalKey: string;
  direction: "asc" | "desc";
};

/**
 * The `sort` axis for one page of work items, mirroring the contract union
 * (`WorkItemSort`) one layer down: `created`/`updated` need only a
 * direction, `score` also carries the pipeline/step/signal triple.
 */
export type WorkItemListSort =
  | { kind: "created"; direction: "asc" | "desc" }
  | { kind: "updated"; direction: "asc" | "desc" }
  | WorkItemListSignalSort;

export type WorkItemListPageOptions = {
  search?: string;
  fieldFilters?: WorkItemListFieldFilter[];
  /** Items carrying every one of these labels. */
  labels?: string[];
  /**
   * Half-open bounds on the item's effective last-updated instant. Carried in
   * the contract's unresolved form (`7d`, `2026-01-14`) rather than as dates:
   * a relative bound is measured against the `now` passed to
   * `listPageByProjectId`, so resolving it earlier would only invite a second,
   * unbound clock into the query.
   */
  updatedAfter?: WorkItemTimeBound;
  updatedBefore?: WorkItemTimeBound;
  /**
   * Restrict to items with a pending/failed `work_item_platform_comment`
   * draft. Only takes effect when `includeAwaitingApprovalData` is `true` —
   * `listWorkItemsByProject` drops this from the options it builds whenever
   * the caller lacks `work-item-platform-comment:write`, so `infra` never
   * has to re-check the permission itself.
   */
  awaitingApproval?: boolean;
  /**
   * Internal gate, set once by `listWorkItemsByProject` from the caller's
   * `work-item-platform-comment:write` permission — never derived from
   * request input. This is the same permission that gates the pending-draft
   * card on the work item detail page, so a caller who sees the badge can
   * always open the item and see the draft it refers to. When `false`, the
   * listing query skips the awaiting-approval join entirely and every row's
   * `awaitingApprovalCount` is a literal `0`, rather than a real count that is
   * computed and then masked.
   */
  includeAwaitingApprovalData?: boolean;
  /** Whose "waiting on you" the Agent filter and Task counts are about. */
  viewerUserId: UuidV7;
  assignee?: WorkItemListAssigneeFilter;
  agent?: WorkItemAgentFilter;
  latestExecutionStatus?: PipelineRunStatus;
  platform?: WorkItemPlatform;
  sort?: WorkItemListSort;
  page: number;
  pageSize: number;
};

/** A resolved assignee filter: one user, or unassigned items. */
export type WorkItemListAssigneeFilter =
  { kind: "user"; userId: UuidV7 } | { kind: "none" };

export type WorkItemListPage = {
  items: {
    workItem: WorkItemEntity;
    signalScore: number | null;
    latestExecutionStatus: PipelineRunStatus | null;
    awaitingApprovalCount: number;
    taskStatusCounts: WorkItemTaskStatusCounts;
  }[];
  total: number;
};

export type WorkItemFieldOption = {
  key: string;
  values: string[];
  truncated: boolean;
};

export type WorkItemRepo = {
  load(id: WorkItemId, dbExecutor?: DbExecutor): Promise<WorkItemEntity | null>;
  loadMany(
    ids: WorkItemId[],
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemEntity[]>;
  /**
   * Direct children of `parentWorkItemId`, ordered by `createdAt` (no
   * explicit sibling-ordering concept in v1 — see the plan's Decision 3).
   */
  listChildren(
    parentWorkItemId: WorkItemId,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemEntity[]>;
  /** How many work items the Task spawned, across all its runs. */
  countSpawnedByTask(taskId: UuidV7, dbExecutor?: DbExecutor): Promise<number>;
  /**
   * One page of a project's work items, with filtering and sorting applied in
   * SQL. `signalScore` and `latestExecutionStatus` are returned alongside each
   * entity rather than on it: both are query metadata, not part of the
   * aggregate.
   *
   * `total` is the count of rows matching the filters, independent of the
   * requested page — an out-of-range page yields empty `items` with the real
   * `total`.
   *
   * `now` resolves the relative `updatedAfter`/`updatedBefore` bounds —
   * always a `TimeProvider` value, never SQL `now()`.
   */
  listPageByProjectId(
    projectId: UuidV7,
    options: WorkItemListPageOptions,
    now: Date,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemListPage>;
  /**
   * Distinct scalar `fields` keys and values across the project, for populating
   * filter dropdowns. Independent of any active filter or page.
   */
  listFieldOptions(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemFieldOption[]>;
  /** The project's distinct labels, sorted, for label suggestions. */
  listLabels(projectId: UuidV7, dbExecutor?: DbExecutor): Promise<string[]>;
  loadByPlatformIdentity(
    projectId: UuidV7,
    platform: WorkItemPlatform,
    sourceIdentity: string,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemEntity | null>;
  loadManyByPlatformIdentities(
    identities: {
      projectId: UuidV7;
      platform: WorkItemPlatform;
      sourceIdentity: string;
    }[],
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemEntity[]>;
  create(
    workItem: WorkItemEntity,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemEntity>;
  createMany(
    workItems: WorkItemEntity[],
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemEntity[]>;
  /**
   * Writes every Scarn-side change except an existing row's description and
   * its version, which only `saveDescription` writes. A new row is inserted
   * whole, description at version 1.
   */
  save(
    workItem: WorkItemEntity,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemEntity>;
  /**
   * The only Scarn-side description write: a compare-and-set on
   * `descriptionVersion`. Writes `workItem.description` only while the stored
   * version is still `expectedVersion`, the one the writer read, and moves the
   * version when the text changes. Throws `WorkItemDescriptionConflict` when
   * the version has moved, so a stale write never clobbers a newer one.
   */
  saveDescription(
    workItem: WorkItemEntity,
    expectedVersion: number,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemEntity>;
  /**
   * The sync/ingestion upsert. A tracker owns a synced item's description, so
   * this overwrites it unconditionally, moving the version when it changes.
   */
  saveMany(
    workItems: WorkItemEntity[],
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemEntity[]>;
  /**
   * Same upsert target/shape as `saveMany` (conflict on
   * `projectId`/`platform`/`platformKey`), but the `ON CONFLICT ... DO
   * UPDATE` only takes effect when the incoming row's `sourceUpdatedAt` is
   * strictly newer than the currently-stored value (or the stored value is
   * `null`) — an atomic SQL guard, not a read-compare-write, so
   * concurrent/out-of-order callers can't race each other into overwriting a
   * newer value with a stale one (see decisions 6/12,
   * docs/plans/github-integration-sync-scaling.md).
   *
   * A conflicting row whose incoming `sourceUpdatedAt` is not newer is left
   * completely untouched and is **omitted from the returned array** (Postgres
   * never emits a row from `RETURNING` when its `DO UPDATE ... WHERE` guard
   * evaluates false) — callers must treat a shorter result array as
   * "some inputs were stale no-ops", not as an error.
   *
   * Only for upserts that want a monotonic-watermark guard: `upsertWorkItems`
   * with `onlyIfSourceNewer` (the GitHub issue webhook path). Callers that
   * mutate a work item without moving its source watermark forward
   * (`editWorkItem`, `setWorkItemParent`, GitHub relationship reparenting,
   * `upsertWorkItems`' default poll-sync path) must keep using
   * `save`/`saveMany` — retrofitting this
   * guard onto those would silently drop title/parent edits whenever
   * `sourceUpdatedAt` is unchanged (e.g. `null` on both sides, the common
   * case for native `scarn`-platform items).
   */
  saveManyIfSourceNewer(
    workItems: WorkItemEntity[],
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemEntity[]>;
  /**
   * The only way an existing row's `state` and closure columns change:
   * `save`/`saveMany` leave them alone. Writes each item's state and closure
   * only if its stored state differs, and returns just the rows it changed,
   * so a concurrent close or reopen that got there first is a no-op.
   */
  setStateMany(
    workItems: WorkItemEntity[],
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemEntity[]>;
  delete(id: WorkItemId, dbExecutor?: DbExecutor): Promise<number>;
  deleteMany(ids: WorkItemId[], dbExecutor?: DbExecutor): Promise<number>;
  /**
   * Deletes every work item in the project. The project's pipeline runs and
   * Tasks restrict-reference work items, so delete those first.
   */
  deleteByProjectId(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<number>;
};

export type WorkItemProjectionFingerprintRepo = {
  load(
    workItemId: WorkItemId,
    specId: string,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemProjectionFingerprintEntity | null>;
  save(
    fingerprint: WorkItemProjectionFingerprintEntity,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemProjectionFingerprintEntity>;
};

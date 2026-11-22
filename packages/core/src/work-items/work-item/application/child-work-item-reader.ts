import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TaskStatus } from "@scarn/core/tasks/task/domain/task-entity";
import type { WorkItemId } from "../domain/work-item-id";

/** A work item's newest Task, with what the children section shows of it. */
export type ChildWorkItemLatestTaskRecord = {
  id: UuidV7;
  status: TaskStatus;
  step: { key: string; name: string } | null;
  /** Its first run's start; `null` before any run. */
  startedAt: Date | null;
  updatedAt: Date;
  /** The newest agent message in its conversation, cut short. */
  lastAgentMessage: string | null;
  /** Its error message, else its latest run's; `null` unless `failed`. */
  errorMessage: string | null;
};

/**
 * Reads what the children section needs beyond the work items themselves,
 * one query per relation for every child at once.
 */
export type ChildWorkItemReader = {
  /** Each item's newest Task. Items that never had a Task have no entry. */
  loadLatestTasks(
    workItemIds: readonly WorkItemId[],
    dbExecutor?: DbExecutor,
  ): Promise<Map<WorkItemId, ChildWorkItemLatestTaskRecord>>;
  /**
   * Each item's open blockers with their titles, oldest block first. Items
   * with no open blocker have no entry.
   */
  loadOpenBlockers(
    workItemIds: readonly WorkItemId[],
    dbExecutor?: DbExecutor,
  ): Promise<Map<WorkItemId, { id: WorkItemId; title: string }[]>>;
};

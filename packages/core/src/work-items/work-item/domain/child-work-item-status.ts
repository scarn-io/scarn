/**
 * Where a child work item stands, as the child work items section groups it.
 * The first rule that matches wins:
 *
 * 1. **Closed**: the item is closed.
 * 2. **Needs a person**: open, and its latest Task is `waiting_for_person`,
 *    `failed` or `cancelled`, or it is ready (no open blockers) and has never
 *    had a Task. This wins over Blocked: a blocked item whose latest Task
 *    failed still needs a person.
 * 3. **Running**: open, and its latest Task is live. Live is every status
 *    that hasn't ended and isn't `waiting_for_person`: `queued`, `running`,
 *    `waiting_for_work` and `waiting_for_concurrency_slot`. A Task waiting
 *    for a concurrency slot or for its blockers holds its place in its
 *    concurrency group and will run without anyone doing anything, so its
 *    item is Running (queued), not Ready or Blocked.
 * 4. **Ready**: open, no open blockers, and nothing running (its latest Task
 *    succeeded).
 * 5. **Blocked**: open, with open blockers.
 */
import type { TaskStatus } from "@scarn/core/tasks/task/domain/task-entity";
import type { WorkItemState } from "./work-item-state";

export const CHILD_WORK_ITEM_STATUSES = [
  "needs_person",
  "running",
  "ready",
  "blocked",
  "closed",
] as const;

export type ChildWorkItemStatus = (typeof CHILD_WORK_ITEM_STATUSES)[number];

const NEEDS_PERSON_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "waiting_for_person",
  "failed",
  "cancelled",
]);

const LIVE_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "waiting_for_concurrency_slot",
  "waiting_for_work",
  "queued",
  "running",
]);

export const childWorkItemStatus = (child: {
  state: WorkItemState;
  hasOpenBlockers: boolean;
  /** `null` when the item has never had a Task. */
  latestTaskStatus: TaskStatus | null;
}): ChildWorkItemStatus => {
  if (child.state === "closed") {
    return "closed";
  }
  const { latestTaskStatus } = child;
  if (latestTaskStatus === null) {
    return child.hasOpenBlockers ? "blocked" : "needs_person";
  }
  if (NEEDS_PERSON_TASK_STATUSES.has(latestTaskStatus)) {
    return "needs_person";
  }
  if (LIVE_TASK_STATUSES.has(latestTaskStatus)) {
    return "running";
  }
  return child.hasOpenBlockers ? "blocked" : "ready";
};

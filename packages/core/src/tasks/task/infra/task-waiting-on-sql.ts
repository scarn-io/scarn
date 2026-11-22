import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { workItemWaitingOnPeopleSql } from "@scarn/core/work-items/work-item/infra/work-item-waiting-on-sql";

/** The columns a Task's waited-on people are derived from. */
export type TaskWaitingOnColumns = {
  taskStatus: AnyColumn | SQL;
  taskStartedByUserId: AnyColumn | SQL;
  workItemAssigneeUserId: AnyColumn | SQL;
  workItemCreatedByUserId: AnyColumn | SQL;
  workItemParentWorkItemId: AnyColumn | SQL;
};

/**
 * The people a Task `waiting_for_person` waits on, read live rather than
 * stored: its work item's assignee, then its creator (or, when the item has
 * neither, its nearest parent's that has either), then whoever started the
 * Task (for a pipeline Task, the run's starter). Matches
 * `workItemWaitingOnUserIds`, which picks who a hand-over notifies. Empty for
 * any other status; may repeat a person.
 */
export const taskWaitingOnUserIdsSql = (
  columns: TaskWaitingOnColumns,
): SQL<string[]> => {
  const workItemPeople = workItemWaitingOnPeopleSql({
    assigneeUserId: columns.workItemAssigneeUserId,
    createdByUserId: columns.workItemCreatedByUserId,
    parentWorkItemId: columns.workItemParentWorkItemId,
  });
  return sql<
    string[]
  >`case when ${columns.taskStatus} = 'waiting_for_person' then array_remove(${workItemPeople} || array[${columns.taskStartedByUserId}]::uuid[], null) else '{}'::uuid[] end`;
};

/** True when the Task waits on `userId`; never null. */
export const taskWaitsOnUserSql = (
  columns: TaskWaitingOnColumns,
  userId: UuidV7,
): SQL<boolean> =>
  sql<boolean>`${userId}::uuid = any(${taskWaitingOnUserIdsSql(columns)})`;

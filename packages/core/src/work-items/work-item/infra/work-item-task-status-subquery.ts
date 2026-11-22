import { sql, type SQL } from "drizzle-orm";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { tasks, workItems } from "@scarn/core/lib/db/schema";
import { taskWaitsOnUserSql } from "@scarn/core/tasks/task/infra/task-waiting-on-sql";
import { effectiveTaskStatusSql } from "@scarn/core/tasks/task/infra/task-effective-status-sql";
import { TASK_STATUS_PRESETS } from "@scarn/core/tasks/task/contracts/task-summary-contracts";
import type { TaskStatus } from "@scarn/core/tasks/task/domain/task-entity";
import type {
  WorkItemAgentFilter,
  WorkItemTaskStatusCounts,
} from "../contracts/work-item-contracts";

/** Alias of the Task-status-counts subquery, as it appears in `FROM`/`JOIN`. */
export const TASK_STATUS_COUNTS_ALIAS = "task_status_counts";
/** Output column carrying the work item id, for the caller's join condition. */
export const TASK_STATUS_COUNTS_WORK_ITEM_ID_COLUMN = "work_item_id";

/** Output column of each count, keyed by its `WorkItemTaskStatusCounts` field. */
export const TASK_STATUS_COUNT_COLUMNS = {
  running: "running_count",
  queued: "queued_count",
  waitingForPerson: "waiting_for_person_count",
  waitingOnYou: "waiting_on_you_count",
  waitingForWork: "waiting_for_work_count",
  failed: "failed_count",
} as const satisfies Record<keyof WorkItemTaskStatusCounts, string>;

const RUNNING_STATUSES: readonly TaskStatus[] = TASK_STATUS_PRESETS.running;
const QUEUED_STATUSES: readonly TaskStatus[] = TASK_STATUS_PRESETS.queued;
const WAITING_ON_BLOCKERS_STATUSES: readonly TaskStatus[] =
  TASK_STATUS_PRESETS.waiting_on_blockers;
const COUNTED_STATUSES: readonly TaskStatus[] = [
  ...RUNNING_STATUSES,
  ...QUEUED_STATUSES,
  ...WAITING_ON_BLOCKERS_STATUSES,
  "waiting_for_person",
  "failed",
];

const taskStatus = effectiveTaskStatusSql({
  id: sql`t.id`,
  status: sql`t.status`,
});

const statusIn = (statuses: readonly TaskStatus[]): SQL =>
  sql`${taskStatus} in (${sql.join(
    statuses.map((status) => sql`${status}`),
    sql`, `,
  )})`;

const waitsOnViewer = (viewerUserId: UuidV7): SQL =>
  taskWaitsOnUserSql(
    {
      taskStatus: sql`t.status`,
      taskStartedByUserId: sql`t.started_by_user_id`,
      workItemAssigneeUserId: sql`w.assignee_user_id`,
      workItemCreatedByUserId: sql`w.created_by_user_id`,
      workItemParentWorkItemId: sql`w.parent_work_item_id`,
    },
    viewerUserId,
  );

/**
 * Per-work-item counts of the project's live and attention-needing Tasks, by
 * `effectiveTaskStatusSql` (a Task whose run lapsed counts as failed).
 * Grouped by `work_item_id`, so the caller's outer `LEFT JOIN` stays 1:1 and
 * cannot inflate `COUNT(*) OVER ()`. "Waiting on you" derives who the Task
 * waits on from its work item and starter, as the Tasks tab's `waitingOnMe`
 * filter does.
 */
export const buildTaskStatusCountsSubquery = (
  projectId: UuidV7,
  viewerUserId: UuidV7,
): SQL => {
  const column = (name: string) => sql.identifier(name);
  return sql`(
    select
      t.work_item_id as ${column(TASK_STATUS_COUNTS_WORK_ITEM_ID_COLUMN)},
      count(*) filter (where ${statusIn(RUNNING_STATUSES)})::int as ${column(TASK_STATUS_COUNT_COLUMNS.running)},
      count(*) filter (where ${statusIn(QUEUED_STATUSES)})::int as ${column(TASK_STATUS_COUNT_COLUMNS.queued)},
      count(*) filter (where t.status = 'waiting_for_person')::int as ${column(TASK_STATUS_COUNT_COLUMNS.waitingForPerson)},
      count(*) filter (where ${waitsOnViewer(viewerUserId)})::int as ${column(TASK_STATUS_COUNT_COLUMNS.waitingOnYou)},
      count(*) filter (where ${statusIn(WAITING_ON_BLOCKERS_STATUSES)})::int as ${column(TASK_STATUS_COUNT_COLUMNS.waitingForWork)},
      count(*) filter (where ${taskStatus} = 'failed')::int as ${column(TASK_STATUS_COUNT_COLUMNS.failed)}
    from ${tasks} t
    join ${workItems} w on w.id = t.work_item_id
    where t.project_id = ${projectId}::uuid
      and t.status::text in (${sql.join(
        COUNTED_STATUSES.map((status) => sql`${status}`),
        sql`, `,
      )})
    group by t.work_item_id
  ) as ${sql.identifier(TASK_STATUS_COUNTS_ALIAS)}`;
};

const agentFilterCondition = (
  agent: WorkItemAgentFilter,
  viewerUserId: UuidV7,
): SQL => {
  switch (agent) {
    case "waiting_on_me":
      return waitsOnViewer(viewerUserId);
    case "running":
      return statusIn(RUNNING_STATUSES);
    case "queued":
      return statusIn(QUEUED_STATUSES);
    case "waiting_on_blockers":
      return statusIn(WAITING_ON_BLOCKERS_STATUSES);
    case "failed":
      return sql`${taskStatus} = 'failed'`;
  }
};

/**
 * Items with at least one Task matching the Agent filter. Correlated on
 * `work_items.id` only, so the fallback count query can use it unchanged.
 * Uses the same conditions as `buildTaskStatusCountsSubquery`, so a matching
 * item always shows a non-zero count for its filter.
 */
export const buildAgentFilterPredicate = (
  agent: WorkItemAgentFilter,
  viewerUserId: UuidV7,
): SQL => sql`exists (
  select 1
  from ${tasks} t
  join ${workItems} w on w.id = t.work_item_id
  where t.work_item_id = ${workItems.id}
    and ${agentFilterCondition(agent, viewerUserId)}
)`;

type TaskStatusCountKey = keyof WorkItemTaskStatusCounts;

/**
 * Select-list entries reading each count off the joined subquery; an item
 * with no counted Task has no row there, hence the `coalesce`.
 */
export const taskStatusCountsSelection = (): Record<
  TaskStatusCountKey,
  SQL<number | string>
> => {
  const read = (key: TaskStatusCountKey) =>
    sql<
      number | string
    >`coalesce(${sql.identifier(TASK_STATUS_COUNTS_ALIAS)}.${sql.identifier(TASK_STATUS_COUNT_COLUMNS[key])}, 0)`;
  return {
    running: read("running"),
    queued: read("queued"),
    waitingForPerson: read("waitingForPerson"),
    waitingOnYou: read("waitingOnYou"),
    waitingForWork: read("waitingForWork"),
    failed: read("failed"),
  };
};

/** The selected counts, as numbers whether the driver returned them as text or not. */
export const toTaskStatusCounts = (
  row: Record<TaskStatusCountKey, number | string>,
): WorkItemTaskStatusCounts => ({
  running: Number(row.running),
  queued: Number(row.queued),
  waitingForPerson: Number(row.waitingForPerson),
  waitingOnYou: Number(row.waitingOnYou),
  waitingForWork: Number(row.waitingForWork),
  failed: Number(row.failed),
});

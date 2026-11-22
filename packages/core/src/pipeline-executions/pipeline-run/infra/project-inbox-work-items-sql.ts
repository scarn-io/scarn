import { sql, type SQL } from "drizzle-orm";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { tasks, workItemBlocks, workItems } from "@scarn/core/lib/db/schema";
import { workItemWaitingOnPeopleSql } from "@scarn/core/work-items/work-item/infra/work-item-waiting-on-sql";

/**
 * The project's work items that wait on a person with no Task to do it: open,
 * ready (no open blocker, the rule `childWorkItemStatus` reads) and never
 * given a Task. Each row carries who it waits on and when it last became
 * ready: its creation, or its newest blocker's close.
 */
const readyWithoutTask = (projectId: UuidV7): SQL => sql`
  select w.id, w.platform_key, w.title, w.labels, w.parent_work_item_id,
    ${workItemWaitingOnPeopleSql({
      assigneeUserId: sql`w.assignee_user_id`,
      createdByUserId: sql`w.created_by_user_id`,
      parentWorkItemId: sql`w.parent_work_item_id`,
    })} as waiting_on_user_ids,
    greatest(w.created_at, (
      select max(b.closed_at) from ${workItemBlocks} k
      join ${workItems} b on b.id = k.blocking_work_item_id
      where k.blocked_work_item_id = w.id
    )) as waiting_since
  from ${workItems} w
  where w.project_id = ${projectId} and w.state = 'open'
    and not exists (select 1 from ${tasks} t where t.work_item_id = w.id)
    and not exists (
      select 1 from ${workItemBlocks} k
      join ${workItems} b on b.id = k.blocking_work_item_id
      where k.blocked_work_item_id = w.id and b.state = 'open'
    )
`;

/** `readyWithoutTask`, kept to the items that wait on `userId`. */
export const readyWorkItemsOnUser = (projectId: UuidV7, userId: UuidV7): SQL =>
  sql`select * from (${readyWithoutTask(projectId)}) x where ${userId}::uuid = any(x.waiting_on_user_ids)`;

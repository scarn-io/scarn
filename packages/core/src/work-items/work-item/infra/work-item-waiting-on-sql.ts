import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { SYSTEM_ACTOR_ID } from "@scarn/core/access/authorization/system-actor";
import { workItems } from "@scarn/core/lib/db/schema";
import { MAX_WAITING_ON_WALK } from "../domain/work-item-waiting-on";

/** The columns of the work item whose people are read. */
export type WorkItemPeopleColumns = {
  assigneeUserId: AnyColumn | SQL;
  createdByUserId: AnyColumn | SQL;
  parentWorkItemId: AnyColumn | SQL;
};

const peopleOf = (assignee: AnyColumn | SQL, creator: AnyColumn | SQL): SQL =>
  sql`array_remove(array[${assignee}, nullif(${creator}, ${SYSTEM_ACTOR_ID}::uuid)]::uuid[], null)`;

/**
 * The people of the nearest ancestor, starting at `parentWorkItemId`, that
 * has an assignee or a creator; `null` when none has. Walks at most
 * `MAX_WAITING_ON_WALK` levels, so a cycle can't run away.
 */
const nearestAncestorPeople = (parentWorkItemId: AnyColumn | SQL): SQL => sql`(
  with recursive chain(parent_id, people, depth) as (
    select a.parent_work_item_id, ${peopleOf(sql`a.assignee_user_id`, sql`a.created_by_user_id`)}, 1
    from ${workItems} a where a.id = ${parentWorkItemId}
    union all
    select a.parent_work_item_id, ${peopleOf(sql`a.assignee_user_id`, sql`a.created_by_user_id`)}, chain.depth + 1
    from chain join ${workItems} a on a.id = chain.parent_id
    where cardinality(chain.people) = 0 and chain.depth < ${MAX_WAITING_ON_WALK}
  )
  select chain.people from chain where cardinality(chain.people) > 0
  order by chain.depth limit 1
)`;

/**
 * Who a work item waits on, read live: its assignee and creator, or, when it
 * has neither, those of its nearest ancestor that has either. The system
 * actor doesn't count as a creator. Matches `workItemWaitingOnUserIds`
 * without the triggering person; never null, possibly empty. The parents are
 * only walked when the item has no one.
 */
export const workItemWaitingOnPeopleSql = (
  columns: WorkItemPeopleColumns,
): SQL<string[]> =>
  sql<
    string[]
  >`coalesce(nullif(${peopleOf(columns.assigneeUserId, columns.createdByUserId)}, '{}'::uuid[]), ${nearestAncestorPeople(columns.parentWorkItemId)}, '{}'::uuid[])`;

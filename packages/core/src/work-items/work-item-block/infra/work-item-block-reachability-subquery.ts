import { sql } from "drizzle-orm";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { workItemBlocks } from "@scarn/core/lib/db/schema";

type ReachabilityRow = {
  reachable: boolean;
};

/**
 * Full transitive cycle detection for a candidate blocking edge (Decision 9
 * of `docs/work-item-relationships-plan.md`).
 *
 * Starting from `fromWorkItemId`, walks `work_item_blocks` forward — from a
 * blocked item to whatever blocks it, transitively — scoped to `projectId`,
 * and reports whether `toWorkItemId` is reachable. A candidate edge
 * `blockingWorkItemId -> blockedWorkItemId` would close a cycle exactly when
 * `blockingWorkItemId` is already reachable starting from
 * `blockedWorkItemId`: some existing chain of blockers already leads back to
 * the item that would newly become a blocker.
 *
 * `UNION` (not `UNION ALL`) de-duplicates visited nodes, which is what keeps
 * this recursive query bounded even if the underlying data ever contained an
 * unexpected cycle — the invariants this same use case enforces should make
 * that impossible, but the query does not rely on that being true to
 * terminate.
 */
export const isWorkItemReachableViaBlocks = async (
  db: DbExecutor,
  projectId: UuidV7,
  fromWorkItemId: UuidV7,
  toWorkItemId: UuidV7,
): Promise<boolean> => {
  const rows = await db.execute<ReachabilityRow>(sql`
    with recursive reachable(work_item_id) as (
      select ${workItemBlocks.blockingWorkItemId} as work_item_id
      from ${workItemBlocks}
      where ${workItemBlocks.projectId} = ${projectId}
        and ${workItemBlocks.blockedWorkItemId} = ${fromWorkItemId}
      union
      select ${workItemBlocks.blockingWorkItemId} as work_item_id
      from ${workItemBlocks}
      join reachable
        on reachable.work_item_id = ${workItemBlocks.blockedWorkItemId}
      where ${workItemBlocks.projectId} = ${projectId}
    )
    select exists (
      select 1 from reachable where work_item_id = ${toWorkItemId}
    ) as reachable
  `);

  return Boolean(rows.rows[0]?.reachable);
};

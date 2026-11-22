import { sql } from "drizzle-orm";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { workItems } from "@scarn/core/lib/db/schema";

/** A project's distinct work item labels, in code-point order. */
export const queryWorkItemLabels = async (
  db: DbExecutor,
  projectId: UuidV7,
): Promise<string[]> => {
  const rows = await db.execute<{ label: string }>(sql`
    select distinct l.label collate "C" as "label"
    from ${workItems}
    cross join lateral unnest(${workItems.labels}) as l(label)
    where ${workItems.projectId} = ${projectId}::uuid
    order by 1
  `);

  return rows.rows.map((row) => row.label);
};

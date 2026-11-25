import { and, desc, eq, isNotNull, like } from "drizzle-orm";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { workItems } from "@scarn/core/lib/db/schema";
import type { WorkItemPlatform } from "../domain/work-item-platform";
import { escapeLikeWildcards } from "./work-item-listing-query";

/**
 * The newest `source_updated_at` among a project's items on `platform` whose
 * key starts with `keyPrefix` (matched literally), or null when there is none.
 */
export const queryMaxSourceUpdatedAt = async (
  db: DbExecutor,
  projectId: UuidV7,
  platform: WorkItemPlatform,
  keyPrefix: string,
): Promise<Date | null> => {
  const [row] = await db
    .select({ sourceUpdatedAt: workItems.sourceUpdatedAt })
    .from(workItems)
    .where(
      and(
        eq(workItems.projectId, projectId),
        eq(workItems.platform, platform),
        like(workItems.platformKey, `${escapeLikeWildcards(keyPrefix)}%`),
        isNotNull(workItems.sourceUpdatedAt),
      ),
    )
    .orderBy(desc(workItems.sourceUpdatedAt))
    .limit(1);

  return row?.sourceUpdatedAt ?? null;
};

import { sql, type SQL } from "drizzle-orm";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { pipelineRuns, workItems } from "@scarn/core/lib/db/schema";
import type { PipelineRunStatus } from "@scarn/core/pipeline-executions/pipeline-run/domain/pipeline-run-entity";

/** Alias of the latest-execution-status subquery, as it appears in `FROM`/`JOIN`. */
export const LATEST_EXECUTION_STATUS_ALIAS = "latest_execution_status";
/** Output column carrying the work item id, for the caller's join condition. */
export const LATEST_EXECUTION_STATUS_WORK_ITEM_ID_COLUMN = "work_item_id";
/** Output column carrying the run status. */
export const LATEST_EXECUTION_STATUS_COLUMN = "status";

/**
 * Stored status of each work item's latest pipeline run, project-wide.
 * `DISTINCT ON (work_item_id)` keeps the caller's outer `LEFT JOIN` 1:1, so it
 * cannot inflate a `COUNT(*) OVER ()`. A work item with no run gets no row
 * here and therefore a `NULL` status through that join.
 *
 * Returned as an aliased `SQL` fragment (rather than a typed subquery) so the
 * caller references it with `sql.identifier(...)` against the constants above.
 */
export const buildLatestExecutionStatusSubquery = (projectId: UuidV7): SQL =>
  sql`(
    select distinct on (${pipelineRuns.workItemId})
      ${pipelineRuns.workItemId} as ${sql.identifier(LATEST_EXECUTION_STATUS_WORK_ITEM_ID_COLUMN)},
      ${pipelineRuns.status} as ${sql.identifier(LATEST_EXECUTION_STATUS_COLUMN)}
    from ${pipelineRuns}
    where ${pipelineRuns.projectId} = ${projectId}
    order by ${pipelineRuns.workItemId}, ${pipelineRuns.createdAt} desc, ${pipelineRuns.id} desc
  ) as ${sql.identifier(LATEST_EXECUTION_STATUS_ALIAS)}`;

/**
 * Items whose latest pipeline run has `status`, correlated on
 * `work_items.id` only so the fallback count query can use it unchanged.
 * Same ordering as `buildLatestExecutionStatusSubquery`, so the filter and the
 * listed status agree.
 */
export const buildLatestExecutionStatusPredicate = (
  status: PipelineRunStatus,
): SQL => sql`(
  select r.status::text
  from ${pipelineRuns} r
  where r.work_item_id = ${workItems.id}
  order by r.created_at desc, r.id desc
  limit 1
) = ${status}`;

import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  nodeVisits,
  pipelineGraphVersions,
  pipelineRuns,
  taskRuns,
} from "@scarn/core/lib/db/schema";
import type { WorkItemListSignalSort } from "../application/work-item-repo";

/** Alias of the latest-score subquery, referenced from the outer statement. */
export const LATEST_SCORES_ALIAS = "latest_scores";
/** Output column of the latest-score subquery. */
export const LATEST_SCORE_COLUMN = "score";

/**
 * Latest numeric score per work item for one `score:<pipeline>:<step>:<result
 * path>` sort: pipeline run → its latest non-superseded visit to a node whose
 * `step` (in the run's pinned version document) is the sort's step key → that
 * visit's succeeded run → the value at the dotted result path. Non-numeric or
 * missing values become NULL. `numeric` comes back from the driver as a
 * string and is coerced at the mapping boundary.
 *
 * Collapses to a single row per work item with `DISTINCT ON`, which keeps the
 * caller's outer `LEFT JOIN` 1:1 so `COUNT(*) OVER ()` cannot be inflated by
 * fan-out.
 */
export const buildLatestSignalScoresSubquery = (
  db: DbExecutor,
  projectId: UuidV7,
  signalSort: WorkItemListSignalSort,
) => {
  const resultValue = sql`(${taskRuns.resultJson} #> string_to_array(${signalSort.signalKey}, '.'))`;
  const score = sql<
    string | null
  >`case when jsonb_typeof(${resultValue}) = 'number' then (${resultValue})::numeric else null end`;
  const nodeStepKey = sql`(${pipelineGraphVersions.definitionJson} -> 'nodes' -> ${nodeVisits.nodeId} ->> 'step')`;

  const visitScores = db
    .select({
      workItemId: pipelineRuns.workItemId,
      score: score.as("score"),
      runCreatedAt: sql`${pipelineRuns.createdAt}`.as("run_created_at"),
      visitCreatedAt: sql`${nodeVisits.createdAt}`.as("visit_created_at"),
      visitId: sql`${nodeVisits.id}`.as("visit_id"),
    })
    .from(pipelineRuns)
    .innerJoin(
      pipelineGraphVersions,
      eq(pipelineGraphVersions.id, pipelineRuns.pipelineGraphVersionId),
    )
    .innerJoin(
      nodeVisits,
      and(
        eq(nodeVisits.pipelineRunId, pipelineRuns.id),
        eq(nodeVisits.nodeKind, "step"),
        ne(nodeVisits.status, "superseded"),
        sql`${nodeStepKey} = ${signalSort.stepKey}`,
      ),
    )
    .leftJoin(
      taskRuns,
      and(
        eq(taskRuns.taskId, nodeVisits.taskId),
        eq(taskRuns.status, "succeeded"),
        isNull(nodeVisits.resultJson),
      ),
    )
    .where(
      and(
        eq(pipelineRuns.projectId, projectId),
        eq(pipelineRuns.pipelineGraphId, signalSort.pipelineDefinitionId),
      ),
    );

  return (
    db
      .selectDistinctOn([sql`combined.work_item_id`], {
        workItemId: sql`combined.work_item_id`.as("workItemId"),
        score: sql`combined.score`.as(LATEST_SCORE_COLUMN),
      })
      .from(sql`(${visitScores}) as combined`)
      // Must lead with the DISTINCT ON expression; the visit id is the final
      // tiebreaker for equal timestamps.
      .orderBy(
        sql`combined.work_item_id`,
        desc(sql`combined.run_created_at`),
        desc(sql`combined.visit_created_at`),
        desc(sql`combined.visit_id`),
      )
      .as(LATEST_SCORES_ALIAS)
  );
};

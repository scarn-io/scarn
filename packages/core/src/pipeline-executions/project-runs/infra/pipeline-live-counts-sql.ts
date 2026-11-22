/**
 * The Pipelines page's live counts: per pipeline definition, its in-progress
 * runs and recent successes, and per node the visits open there now.
 */
import { sql, type SQL } from "drizzle-orm";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  nodeVisits,
  pipelineGraphs,
  pipelineRuns,
} from "@scarn/core/lib/db/schema";

export type RawPipelineTotalsRow = {
  pipeline_definition_id: string;
  in_progress: number;
  done_this_week: number;
};

export type RawNodeLiveCountRow = {
  pipeline_definition_id: string;
  node_id: string;
  running: number;
  waiting: number;
  failed: number;
  lanes: number;
};

const inProgressRun = sql`r.status in ('active', 'waiting')`;

const finishedSince = (since: Date): SQL =>
  sql`coalesce(r.completed_at, r.updated_at) >= ${since.toISOString()}::timestamptz`;

/** Every pipeline definition of the project, with its run totals. */
export const pipelineTotalsSql = (projectId: UuidV7, since: Date): SQL => sql`
  select g.id as pipeline_definition_id,
    (count(r.id) filter (where ${inProgressRun}))::int as in_progress,
    (count(r.id) filter (
      where r.status = 'succeeded' and ${finishedSince(since)}
    ))::int as done_this_week
  from ${pipelineGraphs} g
  left join ${pipelineRuns} r on r.pipeline_graph_id = g.id
  where g.project_id = ${projectId}
  group by g.id`;

/**
 * A failed visit nothing caught: no visit was entered from it. A rerun
 * supersedes it, so it no longer reads as failed.
 */
const uncaughtFailedVisit = sql`v.status = 'failed' and not exists (
  select 1 from ${nodeVisits} cv where cv.from_visit_id = v.id
)`;

const crashedSince = (since: Date): SQL =>
  sql`r.status = 'failed' and r.end_node_id is null and ${finishedSince(since)}`;

/**
 * Visit counts per node: open visits of in-progress runs (`active` is queued
 * or running, `waiting` waits on a person or event), and uncaught failed
 * visits of in-progress runs (a failed lane) or of runs that crashed since
 * `since`.
 */
export const pipelineNodeLiveCountsSql = (
  projectId: UuidV7,
  since: Date,
): SQL => sql`
  select r.pipeline_graph_id as pipeline_definition_id, v.node_id,
    (count(*) filter (where ${inProgressRun} and v.status = 'active'))::int as running,
    (count(*) filter (where ${inProgressRun} and v.status = 'waiting'))::int as waiting,
    (count(*) filter (where ${uncaughtFailedVisit}))::int as failed,
    (count(distinct v.lane_id) filter (
      where ${inProgressRun} and v.status in ('active', 'waiting')
    ))::int as lanes
  from ${pipelineRuns} r
  join ${nodeVisits} v on v.pipeline_run_id = r.id
  where r.project_id = ${projectId}
    and (
      (${inProgressRun} and v.status in ('active', 'waiting', 'failed'))
      or (${crashedSince(since)} and v.status = 'failed')
    )
  group by r.pipeline_graph_id, v.node_id
  having count(*) filter (
    where v.status in ('active', 'waiting') or ${uncaughtFailedVisit}
  ) > 0`;

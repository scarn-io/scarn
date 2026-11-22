import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { WorkItemId } from "@scarn/core/work-items/work-item/domain/work-item-id";
import type {
  Lane,
  LaneGroup,
  LaneGroupPatch,
  LanePatch,
  VisitTask,
} from "../domain/engine/types";
import type { PipelineRunEntity } from "../domain/pipeline-run-entity";
import type { NodeVisitEntity } from "../domain/node-visit-entity";

/**
 * Everything a run recorded: its visits, lanes and the runs of its step
 * visits' Tasks (`visitTasks`, oldest first per visit).
 */
export type PipelineRunHistory = {
  visits: NodeVisitEntity[];
  laneGroups: LaneGroup[];
  lanes: Lane[];
  visitTasks: VisitTask[];
};

export type ConversationVisitRef = {
  pipelineRunId: UuidV7;
  visitId: UuidV7;
  nodeId: string;
  pipelineGraphVersionId: UuidV7;
};

/**
 * The run aggregate's storage: the `pipeline_runs` row plus its visits,
 * lane groups and lanes. A step visit points at its Task
 * (`node_visits.task_id`); its attempts are that Task's runs. Writes are one
 * row at a time so `advance` can apply the engine's commands in order.
 */
export type PipelineRunRepo = {
  load(id: UuidV7, dbExecutor?: DbExecutor): Promise<PipelineRunEntity | null>;
  /** The runs with these ids that exist, in no particular order. */
  loadMany(
    ids: readonly UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<PipelineRunEntity[]>;
  /** `SELECT … FOR UPDATE` on the run row; needs a transaction. */
  lock(id: UuidV7, dbExecutor: DbExecutor): Promise<PipelineRunEntity | null>;
  create(
    run: PipelineRunEntity,
    dbExecutor?: DbExecutor,
  ): Promise<PipelineRunEntity>;
  save(
    run: PipelineRunEntity,
    dbExecutor?: DbExecutor,
  ): Promise<PipelineRunEntity>;
  /** Newest first. */
  listByProjectId(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<PipelineRunEntity[]>;
  listByWorkItemAndPipelineGraphId(
    workItemId: WorkItemId,
    pipelineGraphId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<PipelineRunEntity[]>;
  /**
   * Deletes every run for a work item under one pipeline, with its visits
   * and lanes. The visits' Tasks belong to `TaskRepo` and are left in place;
   * their ids are returned so the caller can pass them to
   * `TaskRepo.deleteMany`.
   */
  deleteByWorkItemAndPipelineGraphId(
    workItemId: WorkItemId,
    pipelineGraphId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<UuidV7[]>;
  /** Like `deleteByWorkItemAndPipelineGraphId`, for every run in the project. */
  deleteByProjectId(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<UuidV7[]>;
  /** The run whose visit owns the Task `taskId` (`node_visits.task_id`); null for a standalone Task. */
  findRunIdByTaskId(
    taskId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<UuidV7 | null>;
  /** The run whose visit owns the Task `taskId`, and who started it; null for a standalone Task. */
  findRunStarterByTaskId(
    taskId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<{ pipelineRunId: UuidV7; startedByUserId: UuidV7 | null } | null>;
  /** The run and node of the visit that queued the TaskRun `taskRunId`; null for a standalone Task. */
  findNodeIdByTaskRunId(
    taskRunId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<{ pipelineRunId: UuidV7; nodeId: string } | null>;
  /** The visit whose Task's conversation this is; null for one no visit's Task has. */
  findVisitByConversationId(
    conversationId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ConversationVisitRef | null>;
  loadHistory(
    pipelineRunId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<PipelineRunHistory>;
  /** Batched `loadHistory`; runs with no rows map to an empty history. */
  loadHistories(
    pipelineRunIds: readonly UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<Map<UuidV7, PipelineRunHistory>>;
  insertVisit(visit: NodeVisitEntity, dbExecutor?: DbExecutor): Promise<void>;
  updateVisit(visit: NodeVisitEntity, dbExecutor?: DbExecutor): Promise<void>;
  insertLaneGroup(
    pipelineRunId: UuidV7,
    group: LaneGroup,
    lanes: readonly Lane[],
    dbExecutor?: DbExecutor,
  ): Promise<void>;
  updateLaneGroup(
    groupId: UuidV7,
    patch: LaneGroupPatch,
    dbExecutor?: DbExecutor,
  ): Promise<void>;
  /** Adds a lane to an existing group. */
  insertLane(lane: Lane, dbExecutor?: DbExecutor): Promise<void>;
  updateLane(
    laneId: UuidV7,
    patch: LanePatch,
    dbExecutor?: DbExecutor,
  ): Promise<void>;
  /** Points a step visit at the Task its first run created. */
  setVisitTask(
    visitId: UuidV7,
    taskId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<void>;
};

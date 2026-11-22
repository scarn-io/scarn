import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import type { StartingAutomation } from "@scarn/core/common/contracts/started-by";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { ConversationStatus } from "@scarn/core/conversations/conversation/domain/conversation-entity";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TaskRunStatus } from "@scarn/core/tasks/task-run/domain/task-run-entity";
import type {
  ProjectRunLookupKind,
  ProjectRunStartedByFilter,
  ProjectRunStatus,
  ProjectRunType,
  ProjectRunWhatRanFilter,
} from "../contracts/project-runs-contracts";

/**
 * What every query reads over: the project's rows, as `viewerUserId` sees
 * them (null for a guest, whom nothing waits on), narrowed by the search and
 * the work item (or its children). `actorUserId` is whoever asks, for the
 * `me` filter.
 */
export type ProjectRunsScope = {
  projectId: UuidV7;
  viewerUserId: UuidV7 | null;
  actorUserId: UuidV7;
  q?: string | undefined;
  workItemId?: UuidV7 | undefined;
};

/** The sidebar facets and the node a pipeline's runs are at. */
export type ProjectRunsFacetFilter = {
  whatRan?: ProjectRunWhatRanFilter | undefined;
  startedBy?: ProjectRunStartedByFilter | undefined;
  /** Only runs with an open visit at this node. */
  atNode?: string | undefined;
};

/** A row's place in the list: `updatedAt` at full (microsecond) precision. */
export type ProjectRunsCursor = { updatedAt: string; id: UuidV7 };

export type ProjectRunsPageFilter = ProjectRunsFacetFilter & {
  statuses: readonly ProjectRunStatus[];
  before?: ProjectRunsCursor | undefined;
  limit: number;
};

type WorkItemRef = { id: UuidV7; platformKey: string; title: string };

/** One row of a page, with its status as SQL derives it. */
export type ProjectRunKeyRecord = {
  type: ProjectRunType;
  id: UuidV7;
  status: ProjectRunStatus;
  /** Microsecond-precision ISO time, for the cursor. */
  updatedAt: string;
  /** The pipeline or step definition's name; `Task` otherwise. */
  whatRanName: string;
  workItem: (WorkItemRef & { parent: WorkItemRef | null }) | null;
  /**
   * A waiting pipeline run's waiters (the work item's, then the starter);
   * empty for any other row.
   */
  runWaiterUserIds: UuidV7[];
};

/** How many rows share these facet values and this status. */
export type ProjectRunCountGroup = {
  status: ProjectRunStatus;
  type: ProjectRunType;
  /** The `whatRan` filter value the rows match. */
  whatRanFilter: ProjectRunWhatRanFilter;
  whatRanName: string;
  startedByAutomation: StartingAutomation | null;
  startedByActor: boolean;
  /** Whether the rows have an open visit at the `atNode` asked for (true when none was). */
  atNode: boolean;
  count: number;
};

/** A standalone Task's latest run, with its liveness clocks applied. */
export type ProjectRunLatestTaskRun = {
  status: TaskRunStatus;
  errorJson: AnyJsonValue | null;
};

/** The conversation a Task without a work item holds. */
export type ProjectRunTaskConversation = {
  status: ConversationStatus;
  firstPersonMessage: string | null;
  lastAgentMessage: string | null;
};

/** A pipeline definition's run totals. */
export type PipelineRunTotalsRecord = {
  pipelineDefinitionId: UuidV7;
  inProgress: number;
  doneThisWeek: number;
};

/** Live visit counts at one node of a pipeline definition. */
export type PipelineNodeLiveCountRecord = {
  pipelineDefinitionId: UuidV7;
  nodeId: string;
  running: number;
  waiting: number;
  failed: number;
  lanes: number;
};

/**
 * Reads the Runs list: one SQL row set of the project's pipeline runs and
 * standalone Tasks (not owned by a node visit), with each row's
 * status derived in SQL, so filters, counts and paging stay in the database;
 * and the per-kind facts that hydrate one page.
 */
export type ProjectRunsReader = {
  /** Most recently updated first (`updatedAt`, then `id`), at most `limit`. */
  listPage(
    scope: ProjectRunsScope,
    filter: ProjectRunsPageFilter,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectRunKeyRecord[]>;
  /** The row of this kind and id in `scope`, if it is one. */
  findKey(
    scope: ProjectRunsScope,
    kind: ProjectRunLookupKind,
    id: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectRunKeyRecord | null>;
  /** Row counts in `scope` grouped by status and facet values. */
  countGroups(
    scope: ProjectRunsScope,
    atNode: string | undefined,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectRunCountGroup[]>;
  /** The body of each open question on these runs, by visit id. */
  loadOpenQuestionBodies(
    pipelineRunIds: readonly UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<Map<UuidV7, string>>;
  /** Each Task's latest run, by Task id; Tasks with none are absent. */
  loadLatestTaskRuns(
    taskIds: readonly UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<Map<UuidV7, ProjectRunLatestTaskRun>>;
  /** The conversation of each of these Tasks, by Task id; Tasks with none are absent. */
  loadTaskConversations(
    taskIds: readonly UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<Map<UuidV7, ProjectRunTaskConversation>>;
  /**
   * Every pipeline definition of the project with its in-progress runs and
   * runs that succeeded since `since`, plus visit counts per node: open
   * visits of in-progress runs, and uncaught failed visits of in-progress
   * runs or of runs that crashed since `since`.
   */
  pipelineLiveCounts(
    projectId: UuidV7,
    since: Date,
    dbExecutor?: DbExecutor,
  ): Promise<{
    pipelines: PipelineRunTotalsRecord[];
    nodes: PipelineNodeLiveCountRecord[];
  }>;
};

import type { StartingAutomation } from "@scarn/core/common/contracts/started-by";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TaskKind } from "@scarn/core/tasks/task-run/domain/task-run-entity";
import type { TaskStatus } from "../domain/task-entity";

/** A Task joined with its work item, step definition and step visit. */
export type TaskSummaryRecord = {
  id: UuidV7;
  projectId: UuidV7;
  kind: TaskKind;
  name: string | null;
  status: TaskStatus;
  prompt: string | null;
  startedByUserId: UuidV7 | null;
  /** The automation that started the Task (or its pipeline run); `null` once deleted. */
  startedByAutomation: StartingAutomation | null;
  conversationId: UuidV7 | null;
  /**
   * Who the Task waits on, derived as it is read (`workItemWaitingOnUserIds`
   * with the Task's starter); empty unless it is `waiting_for_person`.
   */
  waitingOnUserIds: UuidV7[];
  /** null for a Task without a work item (a chat). */
  workItem: { id: UuidV7; platformKey: string; title: string } | null;
  /** The chat a Task without a work item answers; `title` previews its first question. */
  repoConversation: { id: UuidV7; title: string } | null;
  stepDefinition: {
    id: UuidV7;
    key: string;
    name: string;
    version: number;
  } | null;
  pipelineRunId: UuidV7 | null;
  nodeId: string | null;
  /** The step visit's pipeline name and its execution's 1-based number on the work item. */
  pipelineRun: { name: string; number: number } | null;
  /** The latest run's number; `null` before the first run. */
  runNumber: number | null;
  /** See `taskSummarySchema.durationMs`. */
  durationMs: number | null;
  /** The Task's error message, else its latest run's. */
  errorMessage: string | null;
  /** The newest agent message in the Task's conversation, cut short. */
  lastAgentMessage: string | null;
  /** The latest run's newest displayable log text, cut short; `null` once archived. */
  lastLogText: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** The filters the counts honour: everything but status and paging. */
export type ProjectTaskSummaryScope = {
  kind?: TaskKind | undefined;
  /** Only Tasks that wait on this person (see `waitingOnUserIds`). */
  waitingOnUserId?: UuidV7 | undefined;
  /** Only Tasks this person started. */
  startedByUserId?: UuidV7 | undefined;
  workItemIds?: readonly UuidV7[] | undefined;
  /** Only each work item's newest Task, whatever the other filters; every chat Task stays. */
  latestPerWorkItem?: boolean | undefined;
  /** Leave out chat Tasks whose chat has ended (its conversation is closed). */
  excludeEndedChats?: boolean | undefined;
};

export type ProjectTaskSummaryFilter = ProjectTaskSummaryScope & {
  statuses?: readonly TaskStatus[] | undefined;
  /** Only Tasks ordered after this one (newest first). */
  beforeTaskId?: UuidV7 | undefined;
  limit: number;
};

/** Reads Task list rows and view headers in one query each. */
export type TaskSummaryReader = {
  /** The project's Tasks, newest first (`createdAt`, then `id`). */
  listByProject(
    projectId: UuidV7,
    filter: ProjectTaskSummaryFilter,
    dbExecutor?: DbExecutor,
  ): Promise<TaskSummaryRecord[]>;
  /** How many of the project's Tasks in `scope` have each status; absent statuses have none. */
  countByStatus(
    projectId: UuidV7,
    scope: ProjectTaskSummaryScope,
    dbExecutor?: DbExecutor,
  ): Promise<Map<TaskStatus, number>>;
  loadByTaskId(
    taskId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<TaskSummaryRecord | null>;
  /** The Tasks with these ids that exist, in no particular order. */
  loadByTaskIds(
    taskIds: readonly UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<TaskSummaryRecord[]>;
  /** The Task counts the project inbox shows `userId`, in one query. */
  countInbox(
    projectId: UuidV7,
    userId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<InboxTaskCounts>;
};

/** Tasks of ended chats (conversation closed) are never counted. */
export type InboxTaskCounts = {
  /** Agent Tasks `waiting_for_person` that wait on the person. */
  agentWaitingOnUser: number;
  /** Failed Tasks the person started. */
  failedStartedByUser: number;
  /** Tasks `waiting_for_person` that don't wait on the person. */
  waitingOnOthers: number;
};

import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { DecisionActionContract } from "../contracts/pipeline-run-contracts";

type ProjectInboxWaitRecordBase = {
  pipelineRunId: UuidV7;
  visitId: UuidV7;
  nodeId: string;
  pipelineName: string;
  workItem: { id: UuidV7; platformKey: string; title: string };
  /** The people the wait waits on: the work item's creator and the run's starter, deduplicated. */
  waitingOnUserIds: UuidV7[];
  askedAt: string;
};

/** An open question or a waiting decision visit, with what its inbox row shows. */
export type ProjectInboxWaitRecord =
  | (ProjectInboxWaitRecordBase & {
      kind: "reply";
      questionId: UuidV7;
      commentId: UuidV7;
      body: string;
    })
  | (ProjectInboxWaitRecordBase & {
      kind: "decision";
      title: string | null;
      actions: DecisionActionContract[];
    });

/** A ready work item that has never had a Task, with what its inbox row shows. */
export type ProjectInboxWorkItemRecord = {
  id: UuidV7;
  platformKey: string;
  title: string;
  labels: string[];
  parent: { id: UuidV7; title: string } | null;
  /** Its assignee and creator, or its nearest parent's (`workItemWaitingOnUserIds`). */
  waitingOnUserIds: UuidV7[];
  /** When it became ready, as far as Scarn knows: its creation, or its last blocker's close. */
  waitingSince: string;
};

/**
 * Reads what waits on one person across a project's work items: open
 * pipeline questions, and decision waits on runs still going, which are on a
 * person when they created the work item or started the run; and ready work
 * items that have never had a Task, which are on the people
 * `workItemWaitingOnUserIds` picks.
 */
export type ProjectInboxWaitReader = {
  /** Newest first, at most `limit`. */
  listOnUser(
    projectId: UuidV7,
    userId: UuidV7,
    limit: number,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectInboxWaitRecord[]>;
  countOnUser(
    projectId: UuidV7,
    userId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<number>;
  /** Ready work items never given a Task that wait on `userId`; most recently ready first, at most `limit`. */
  listWorkItemsOnUser(
    projectId: UuidV7,
    userId: UuidV7,
    limit: number,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectInboxWorkItemRecord[]>;
  countWorkItemsOnUser(
    projectId: UuidV7,
    userId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<number>;
};

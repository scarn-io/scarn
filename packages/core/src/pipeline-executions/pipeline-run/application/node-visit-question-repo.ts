import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { QuestionPatch, VisitQuestion } from "../domain/engine/types";

/** A question asked on a work item: its run, the comment's body and who started the run. */
export type WorkItemQuestionRecord = {
  pipelineRunId: UuidV7;
  question: VisitQuestion;
  body: string;
  runTriggeredByUserId: UuidV7 | null;
};

/**
 * `node_visit_questions`: the question comments a run's visits wait on. The
 * comment row is written before the question that points at it.
 */
export type NodeVisitQuestionRepo = {
  /** Oldest first. */
  loadByRunId(
    pipelineRunId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<VisitQuestion[]>;
  /** Batched `loadByRunId`; runs without questions map to `[]`. */
  loadByRunIds(
    pipelineRunIds: readonly UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<Map<UuidV7, VisitQuestion[]>>;
  /** Every question asked by a comment on `workItemId`, with its run; oldest first. */
  loadByWorkItemId(
    workItemId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemQuestionRecord[]>;
  /** Ids of the comments on `workItemId` that are questions, from any run. */
  loadCommentIdsByWorkItemId(
    workItemId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<Set<string>>;
  /** The open question asked by `commentId`, with its run; null if none. */
  findOpenByCommentId(
    commentId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<{ pipelineRunId: UuidV7; question: VisitQuestion } | null>;
  create(
    pipelineRunId: UuidV7,
    question: VisitQuestion,
    dbExecutor?: DbExecutor,
  ): Promise<void>;
  update(
    questionId: UuidV7,
    patch: QuestionPatch,
    dbExecutor?: DbExecutor,
  ): Promise<void>;
};

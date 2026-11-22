import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  nodeVisitQuestions,
  pipelineRuns,
  workItemComments,
} from "@scarn/core/lib/db/schema";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { QuestionPatch, VisitQuestion } from "../domain/engine/types";
import type {
  NodeVisitQuestionRepo,
  WorkItemQuestionRecord,
} from "../application/node-visit-question-repo";

type QuestionRow = typeof nodeVisitQuestions.$inferSelect;

const questionRowToEngine = (row: QuestionRow): VisitQuestion => ({
  id: row.id,
  visitId: row.visitId,
  commentId: row.commentId,
  status: row.status,
  answerCommentId: row.answerCommentId,
  answeredByUserId: row.answeredByUserId,
  createdAt: row.createdAt.toISOString(),
  resolvedAt: row.resolvedAt?.toISOString() ?? null,
});

const questionPatchToRow = (patch: QuestionPatch) =>
  patch.status === "answered"
    ? {
        status: patch.status,
        answerCommentId: patch.answerCommentId,
        answeredByUserId: patch.answeredByUserId,
        resolvedAt: new Date(patch.resolvedAt),
      }
    : { status: patch.status, resolvedAt: new Date(patch.resolvedAt) };

export class DrizzleNodeVisitQuestionRepo implements NodeVisitQuestionRepo {
  async loadByRunId(
    pipelineRunId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<VisitQuestion[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(nodeVisitQuestions)
      .where(eq(nodeVisitQuestions.pipelineRunId, pipelineRunId))
      .orderBy(asc(nodeVisitQuestions.createdAt), asc(nodeVisitQuestions.id));
    return rows.map(questionRowToEngine);
  }

  async loadByRunIds(
    pipelineRunIds: readonly UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<Map<UuidV7, VisitQuestion[]>> {
    const byRun = new Map<UuidV7, VisitQuestion[]>(
      pipelineRunIds.map((id) => [id, []]),
    );
    if (pipelineRunIds.length === 0) {
      return byRun;
    }
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(nodeVisitQuestions)
      .where(inArray(nodeVisitQuestions.pipelineRunId, [...pipelineRunIds]))
      .orderBy(asc(nodeVisitQuestions.createdAt), asc(nodeVisitQuestions.id));
    for (const row of rows) {
      byRun.get(row.pipelineRunId as UuidV7)?.push(questionRowToEngine(row));
    }
    return byRun;
  }

  async loadByWorkItemId(
    workItemId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemQuestionRecord[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select({
        question: nodeVisitQuestions,
        body: workItemComments.body,
        runTriggeredByUserId: pipelineRuns.triggeredByUserId,
      })
      .from(nodeVisitQuestions)
      .innerJoin(
        workItemComments,
        eq(workItemComments.id, nodeVisitQuestions.commentId),
      )
      .innerJoin(
        pipelineRuns,
        eq(pipelineRuns.id, nodeVisitQuestions.pipelineRunId),
      )
      .where(eq(workItemComments.workItemId, workItemId))
      .orderBy(asc(nodeVisitQuestions.createdAt), asc(nodeVisitQuestions.id));
    return rows.map(({ question, body, runTriggeredByUserId }) => ({
      pipelineRunId: question.pipelineRunId as UuidV7,
      question: questionRowToEngine(question),
      body,
      runTriggeredByUserId: runTriggeredByUserId as UuidV7 | null,
    }));
  }

  async loadCommentIdsByWorkItemId(
    workItemId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<Set<string>> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select({ commentId: nodeVisitQuestions.commentId })
      .from(nodeVisitQuestions)
      .innerJoin(
        workItemComments,
        eq(workItemComments.id, nodeVisitQuestions.commentId),
      )
      .where(eq(workItemComments.workItemId, workItemId));
    return new Set(rows.map((row) => row.commentId));
  }

  async findOpenByCommentId(
    commentId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<{ pipelineRunId: UuidV7; question: VisitQuestion } | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(nodeVisitQuestions)
      .where(
        and(
          eq(nodeVisitQuestions.commentId, commentId),
          eq(nodeVisitQuestions.status, "open"),
        ),
      )
      .limit(1);
    return row
      ? {
          pipelineRunId: row.pipelineRunId as UuidV7,
          question: questionRowToEngine(row),
        }
      : null;
  }

  async create(
    pipelineRunId: UuidV7,
    question: VisitQuestion,
    dbExecutor?: DbExecutor,
  ): Promise<void> {
    const db = dbExecutor ?? getDb();
    await db.insert(nodeVisitQuestions).values({
      id: question.id,
      pipelineRunId,
      visitId: question.visitId,
      commentId: question.commentId,
      status: question.status,
      answerCommentId: question.answerCommentId,
      answeredByUserId: question.answeredByUserId,
      createdAt: new Date(question.createdAt),
      resolvedAt: question.resolvedAt ? new Date(question.resolvedAt) : null,
    });
  }

  async update(
    questionId: UuidV7,
    patch: QuestionPatch,
    dbExecutor?: DbExecutor,
  ): Promise<void> {
    const db = dbExecutor ?? getDb();
    await db
      .update(nodeVisitQuestions)
      .set(questionPatchToRow(patch))
      .where(eq(nodeVisitQuestions.id, questionId));
  }
}

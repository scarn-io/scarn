import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  CoreValidationError,
  ResourceNotFoundError,
} from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  createWorkItemComment,
  type CreateWorkItemCommentDeps,
} from "@scarn/core/work-items/work-item-comment/application/create-work-item-comment";
import {
  deleteWorkItemComment,
  type DeleteWorkItemCommentDeps,
} from "@scarn/core/work-items/work-item-comment/application/delete-work-item-comment";
import {
  editWorkItemComment,
  type EditWorkItemCommentDeps,
} from "@scarn/core/work-items/work-item-comment/application/edit-work-item-comment";
import {
  deleteWorkItemCommentInputSchema,
  editWorkItemCommentInputSchema,
  type DeleteWorkItemCommentInput,
  type EditWorkItemCommentInput,
  type WorkItemCommentContract,
} from "@scarn/core/work-items/work-item-comment/contracts/work-item-comment-contracts";
import {
  answerQuestionInputSchema,
  type AnswerQuestionInput,
} from "../contracts/pipeline-run-contracts";
import type { NodeVisitQuestionRepo } from "./node-visit-question-repo";
import {
  withAdvance,
  type AdvanceTarget,
  type TaskAndAdvanceDeps,
} from "./task-and-advance";

/**
 * Answers a wait visit's open question with a reply: the reply is saved as a
 * threaded comment under the question's comment, and the run advances with
 * `question_answered` in the same transaction. A question that isn't open,
 * or whose visit isn't waiting, rolls the reply back
 * (`PIPELINE_RUN_QUESTION_NOT_OPEN`). Needs `comments:create`, the
 * permission `createWorkItemComment` checks.
 */
export const answerQuestionAndAdvance = async (
  input: AnswerQuestionInput,
  deps: CreateWorkItemCommentDeps & TaskAndAdvanceDeps,
): Promise<WorkItemCommentContract> => {
  const parsed = answerQuestionInputSchema.parse(input);
  const pipelineRunId = parseUuidV7(parsed.pipelineExecutionId);
  return Result.unwrap(
    await withAdvance<WorkItemCommentContract, ResourceNotFoundError>(
      async (tx) => {
        const run = await deps.pipelineRunRepo.load(pipelineRunId, tx);
        const question = run
          ? (await deps.nodeVisitQuestionRepo.loadByRunId(run.id, tx)).find(
              (entry) => entry.id === parsed.questionId,
            )
          : undefined;
        if (!run || !question) {
          return Result.err(
            new ResourceNotFoundError("Question", parsed.questionId),
          );
        }
        return Result.ok(
          await createWorkItemComment(
            {
              workItemId: run.workItemId,
              body: parsed.body,
              parentCommentId: question.commentId,
            },
            { ...deps, dbExecutor: tx },
          ),
        );
      },
      (comment): Promise<AdvanceTarget> =>
        Promise.resolve({
          pipelineRunId,
          event: {
            type: "question_answered",
            questionId: parsed.questionId,
            userId: deps.userAuthz.actorId,
            answer: { commentId: comment.id, body: comment.body },
          },
        }),
      deps,
      deps.dbExecutor,
      (advanced) =>
        advanced.ignored === null
          ? null
          : new CoreValidationError(
              `The question can't be answered: ${advanced.ignored.message}`,
              "PIPELINE_RUN_QUESTION_NOT_OPEN",
            ),
    ),
  );
};

type QuestionGuardDeps = {
  nodeVisitQuestionRepo: NodeVisitQuestionRepo;
  dbExecutor?: DbExecutor | undefined;
};

const assertNotOpenQuestion = async (
  commentId: string,
  deps: QuestionGuardDeps,
  tx: DbExecutor,
): Promise<void> => {
  const open = await deps.nodeVisitQuestionRepo.findOpenByCommentId(
    parseUuidV7(commentId),
    tx,
  );
  if (open) {
    throw new CoreValidationError(
      "A question comment can't be changed while its question is open",
      "WORK_ITEM_COMMENT_QUESTION_OPEN",
    );
  }
};

/** `editWorkItemComment`, refused while the comment's question is open. */
export const editWorkItemCommentGuarded = async (
  input: EditWorkItemCommentInput,
  deps: EditWorkItemCommentDeps & QuestionGuardDeps,
): Promise<WorkItemCommentContract> =>
  await (deps.dbExecutor ?? getDb()).transaction(async (tx) => {
    await assertNotOpenQuestion(
      editWorkItemCommentInputSchema.parse(input).commentId,
      deps,
      tx,
    );
    return await editWorkItemComment(input, { ...deps, dbExecutor: tx });
  });

/** `deleteWorkItemComment`, refused while the comment's question is open. */
export const deleteWorkItemCommentGuarded = async (
  input: DeleteWorkItemCommentInput,
  deps: DeleteWorkItemCommentDeps & QuestionGuardDeps,
): Promise<number> =>
  await (deps.dbExecutor ?? getDb()).transaction(async (tx) => {
    await assertNotOpenQuestion(
      deleteWorkItemCommentInputSchema.parse(input),
      deps,
      tx,
    );
    return await deleteWorkItemComment(input, { ...deps, dbExecutor: tx });
  });

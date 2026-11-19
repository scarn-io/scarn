import { ActionError, unwrapAction } from "./lib/action-error";
import type { WorkItemActionClient } from "./lib/action-clients";
import type {
  WorkItemComment,
  WorkItemQuestion,
} from "./lib/work-item-api-types";

/**
 * The safe actions on a work item: add a comment, and answer a pipeline run's
 * open question (which resumes the step waiting on it).
 */

type WorkItemActionOptions = {
  client: WorkItemActionClient;
  workItemId: string;
  body: string;
};

export async function addComment(
  options: WorkItemActionOptions,
): Promise<WorkItemComment> {
  const { client, workItemId, body } = options;
  return unwrapAction(
    `comment on work item ${workItemId}`,
    await client.workItemComments.createWorkItemComment({
      body: { workItemId, body },
    }),
  );
}

/**
 * Finds `questionId` among the work item's questions (for its pipeline run)
 * and answers it. A question that isn't open is refused before calling.
 */
export async function answerQuestion(
  options: WorkItemActionOptions & { questionId: string },
): Promise<{ question: WorkItemQuestion; comment: WorkItemComment }> {
  const { client, workItemId, questionId } = options;
  const questions = unwrapAction(
    `load the questions of work item ${workItemId}`,
    await client.workItems.listWorkItemQuestions({
      path: { workItemId },
    }),
  );
  const question = questions.find(
    (candidate) => candidate.questionId === questionId,
  );
  if (question === undefined) {
    const open = questions
      .filter((candidate) => candidate.status === "open")
      .map((candidate) => candidate.questionId);
    throw new ActionError(
      "not_found",
      `Work item ${workItemId} has no question ${questionId}. Open questions: ${open.join(", ") || "(none)"}.`,
    );
  }
  if (question.status !== "open") {
    throw new ActionError(
      "conflict",
      `Question ${questionId} is already ${question.status.replace("_", " ")}.`,
    );
  }
  const comment = unwrapAction(
    `answer question ${questionId}`,
    await client.pipelineExecutions.answerQuestion({
      path: { pipelineExecutionId: question.pipelineExecutionId, questionId },
      body: { body: options.body },
    }),
  );
  return { question, comment };
}

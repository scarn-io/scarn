import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UsernameReader } from "@scarn/core/organizations/organization/application/username-reader";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { WorkItemRepo } from "@scarn/core/work-items/work-item/application/work-item-repo";
import { parseWorkItemId } from "@scarn/core/work-items/work-item/domain/work-item-id";
import {
  listWorkItemQuestionsInputSchema,
  type ListWorkItemQuestionsInput,
  type WorkItemQuestionContract,
} from "../contracts/pipeline-run-contracts";
import type { NodeVisitQuestionRepo } from "./node-visit-question-repo";

/**
 * The question comments on a work item, from any run, oldest first, each
 * with who an open one waits on: the work item's creator and the run's
 * starter, as `notifyWaiting` tells. The comments UI reads it to show each
 * question's state and the agents panel to answer open ones; the comments
 * API itself knows nothing about runs. Gated like the comments it describes,
 * on `comments:read`.
 */
export const listWorkItemQuestions = async (
  input: ListWorkItemQuestionsInput,
  deps: {
    userAuthz: UserAuthorizationService;
    workItemRepo: WorkItemRepo;
    nodeVisitQuestionRepo: NodeVisitQuestionRepo;
    usernameReader: UsernameReader;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<WorkItemQuestionContract[], ResourceNotFoundError>> => {
  const workItemId = parseWorkItemId(
    listWorkItemQuestionsInputSchema.parse(input),
  );
  const workItem = await deps.workItemRepo.load(workItemId, deps.dbExecutor);
  if (!workItem) {
    return Result.err(new ResourceNotFoundError("Work item", workItemId));
  }
  await deps.userAuthz.requireProjectPermission({
    projectId: workItem.projectId,
    permission: "comments:read",
    dbExecutor: deps.dbExecutor,
  });
  const questions = await deps.nodeVisitQuestionRepo.loadByWorkItemId(
    parseUuidV7(workItemId),
    deps.dbExecutor,
  );
  const waitingOnByQuestion = new Map(
    questions.map(({ question, runTriggeredByUserId }) => [
      question.id,
      question.status === "open"
        ? [
            ...new Set(
              [workItem.createdByUserId, runTriggeredByUserId].filter(
                (id): id is UuidV7 => !!id,
              ),
            ),
          ]
        : [],
    ]),
  );
  const usernames = await deps.usernameReader.loadUsernamesByUserId(
    [...new Set([...waitingOnByQuestion.values()].flat())],
    deps.dbExecutor,
  );
  return Result.ok(
    questions.map(({ pipelineRunId, question, body }) => {
      const waitingOn = waitingOnByQuestion.get(question.id) ?? [];
      return {
        questionId: question.id as UuidV7,
        commentId: question.commentId as UuidV7,
        visitId: question.visitId as UuidV7,
        pipelineExecutionId: pipelineRunId,
        status: question.status,
        body,
        askedAt: question.createdAt,
        waitingOnYou: waitingOn.includes(deps.userAuthz.actorId),
        waitingOn: waitingOn.map((userId) => ({
          userId,
          username: usernames.get(userId)?.username ?? null,
        })),
      };
    }),
  );
};

import type { ProjectRole } from "@/projects/project/domain/project-role";
import type { PipelineDocument } from "@scarn/sdk/contracts/pipeline-document";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { parseWorkItemCommentId } from "@/work-items/work-item-comment/domain/work-item-comment-id";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { unwrapAsync } from "tests/utils";
import { createPipelineRunHarness } from "./pipeline-run-test-support";

/**
 * A pipeline-run harness plus the calls the question tests make: a pipeline
 * whose `evaluate` asks for details through a reply wait, a run parked on
 * that wait, and the comment, question, answer and continue routes.
 */
export const createQuestionHarness = (
  name: string,
  options?: Parameters<typeof createPipelineRunHarness>[1],
) => {
  const harness = createPipelineRunHarness(name, options);

  const headers = () => harness.requireSetup().headers;

  const replyDocument = (): PipelineDocument => {
    const { stepKey } = harness.requireSetup();
    return {
      schemaVersion: 1,
      key: harness.uniqueKey("questions"),
      start: { to: "evaluate" },
      nodes: {
        evaluate: {
          kind: "step",
          step: stepKey,
          next: {
            routes: [
              {
                when: { path: "result.quality", op: "lessThan", value: 0.1 },
                to: "ask-for-details",
                args: { questions: "result.missingDetails" },
              },
            ],
            otherwise: { to: "done" },
          },
        },
        "ask-for-details": {
          kind: "wait",
          for: "reply",
          maxRuns: 2,
          catch: [{ on: ["Scarn.MaxRunsExceeded"], to: "gave-up" }],
          next: {
            routes: [{ to: "evaluate", args: { reply: "result.body" } }],
          },
        },
        done: { kind: "succeed" },
        "gave-up": { kind: "fail", error: "InsufficientDetail" },
      },
    };
  };

  const lowQuality = {
    quality: 0.05,
    missingDetails: ["Which browser were you using?"],
  };

  const listQuestions = async (workItemId: UuidV7, authHeaders = headers()) =>
    await unwrapAsync(
      harness.apiClient.api["work-items"]({ workItemId }).questions.get({
        headers: authHeaders,
      }),
    );

  const listComments = async (workItemId: UuidV7) =>
    await unwrapAsync(
      harness.apiClient.api["work-item-comments"].get({
        query: { workItemId: parseWorkItemId(workItemId) },
        headers: headers(),
      }),
    );

  const postComment = (
    body: {
      workItemId: UuidV7;
      body: string;
      parentCommentId?: UuidV7;
    },
    authHeaders = headers(),
  ) =>
    harness.apiClient.api["work-item-comments"].post(
      {
        body: body.body,
        workItemId: parseWorkItemId(body.workItemId),
        ...(body.parentCommentId
          ? { parentCommentId: parseWorkItemCommentId(body.parentCommentId) }
          : {}),
      },
      { headers: authHeaders },
    );

  const answerRoute = (
    executionId: UuidV7,
    questionId: UuidV7,
    body: string,
    authHeaders = headers(),
  ) =>
    harness.apiClient.api["pipeline-executions"]({
      pipelineExecutionId: executionId,
    })
      .questions({ questionId })
      .answer.post({ body }, { headers: authHeaders });

  const continueRoute = (
    executionId: UuidV7,
    questionId: UuidV7,
    authHeaders = headers(),
  ) =>
    harness.apiClient.api["pipeline-executions"]({
      pipelineExecutionId: executionId,
    })
      .questions({ questionId })
      .continue.post(undefined, { headers: authHeaders });

  /** Starts a run and completes its first `evaluate` with low quality. */
  const startWaitingRun = async () => {
    const started = await harness.startRun(replyDocument());
    const executionId = started.executionId;
    const workItemId = parseUuidV7(started.workItemId);
    await harness.complete(
      await harness.claimOne(workItemId),
      "succeeded",
      lowQuality,
    );
    const [question] = await listQuestions(workItemId);
    if (!question) {
      throw new Error("Expected a question");
    }
    return {
      executionId,
      workItemId,
      question,
      questionId: question.questionId,
      commentId: question.commentId,
    };
  };

  const questionStatus = async (workItemId: UuidV7, questionId: string) =>
    (await listQuestions(workItemId)).find(
      (question) => question.questionId === questionId,
    )?.status;

  /** A second project member holding only `permissions`. */
  const memberWith = async (role: ProjectRole) => {
    const member = await createTestUserAndSession({
      email: `questions-member-${crypto.randomUUID()}@example.com`,
    });
    await unwrapAsync(
      harness.apiClient.api
        .projects({ projectId: harness.requireSetup().projectId })
        .members({ userId: member.userId })
        .role.put({ role }, { headers: headers() }),
    );
    return { ...member.authHeaders };
  };

  return {
    harness,
    headers,
    listQuestions,
    listComments,
    postComment,
    answerRoute,
    continueRoute,
    startWaitingRun,
    questionStatus,
    memberWith,
  };
};

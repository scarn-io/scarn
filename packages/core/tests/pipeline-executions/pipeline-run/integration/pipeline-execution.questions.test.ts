import { beforeAll, describe, expect } from "bun:test";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { serialTest, unwrapAsync } from "tests/utils";
import { createQuestionHarness } from "./question-test-support";

describe("pipeline execution questions: replies and reads", () => {
  const {
    harness,
    headers,
    listQuestions,
    listComments,
    postComment,
    answerRoute,
    startWaitingRun,
    questionStatus,
    memberWith,
  } = createQuestionHarness("pipeline-run-questions");

  beforeAll(async () => {
    await harness.setUp();
  });

  serialTest(
    "a waiting reply run shows what it waits for and the question it asked",
    async () => {
      const { executionId, workItemId, question } = await startWaitingRun();

      const waiting = await harness.getRun(executionId);
      expect(waiting).toMatchObject({
        runStatus: "waiting",
        status: "waiting",
        waitingFor: "reply",
      });
      const ask = harness.visitOf(waiting, "ask-for-details");
      expect(ask).toMatchObject({
        nodeKind: "wait",
        status: "waiting",
        waitFor: "reply",
        questions: [
          {
            questionId: question.questionId,
            commentId: question.commentId,
            status: "open",
          },
        ],
      });
      expect(harness.visitOf(waiting, "evaluate")).toMatchObject({
        waitFor: null,
        questions: [],
      });
      const { userId } = harness.requireSetup();
      expect(question).toEqual({
        questionId: question.questionId,
        commentId: question.commentId,
        visitId: ask.id,
        pipelineExecutionId: executionId,
        status: "open",
        body: expect.stringContaining(
          "Which browser were you using?",
        ) as string,
        askedAt: expect.any(String) as string,
        waitingOnYou: true,
        waitingOn: [{ userId, username: expect.any(String) as string }],
      });

      const [questionComment] = await listComments(workItemId);
      expect(questionComment).toMatchObject({
        id: question.commentId,
        authorKind: "agent",
        authorUserId: null,
        parentCommentId: null,
      });
      expect(questionComment?.body).toContain("Which browser were you using?");
    },
    30_000,
  );

  serialTest(
    "answering the question saves the reply under its comment and resumes the run with a new evaluate Task",
    async () => {
      const { executionId, workItemId, questionId, commentId } =
        await startWaitingRun();

      const reply = await unwrapAsync(
        answerRoute(executionId, questionId, "Chrome 120 on macOS"),
      );
      expect(reply.parentCommentId).toBe(commentId);
      expect(reply.body).toBe("Chrome 120 on macOS");
      const [answered] = (await listQuestions(workItemId)).filter(
        (question) => question.questionId === questionId,
      );
      expect(answered).toMatchObject({
        status: "answered",
        waitingOnYou: false,
        waitingOn: [],
      });

      const resumed = await harness.getRun(executionId);
      expect(resumed).toMatchObject({ runStatus: "active", waitingFor: null });
      expect(
        resumed.visits.find((visit) => visit.nodeId === "ask-for-details"),
      ).toMatchObject({
        status: "succeeded",
        result: {
          replied: true,
          body: "Chrome 120 on macOS",
          commentId: reply.id,
        },
        questions: [{ questionId, commentId, status: "answered" }],
      });

      const claimed = await harness.claimOne(workItemId);
      const task = await harness.getTaskRun(claimed.taskId);
      expect(task.inputJson).toMatchObject({ reply: "Chrome 120 on macOS" });
      expect(task.inputJson).not.toHaveProperty("workItem");
      expect(task.inputJson).not.toHaveProperty("workItemComments");

      await harness.complete(claimed, "succeeded", { quality: 0.9 });
      expect((await harness.getRun(executionId)).runStatus).toBe("succeeded");
    },
    30_000,
  );

  serialTest(
    "a threaded reply to the question comment is a plain comment and leaves the run waiting",
    async () => {
      const { executionId, workItemId, questionId, commentId } =
        await startWaitingRun();

      const reply = await unwrapAsync(
        postComment({
          workItemId,
          body: "Chrome 120 on macOS",
          parentCommentId: commentId,
        }),
      );

      expect(reply.parentCommentId).toBe(commentId);
      expect(await questionStatus(workItemId, questionId)).toBe("open");
      expect((await harness.getRun(executionId)).runStatus).toBe("waiting");
    },
    30_000,
  );

  serialTest(
    "a member with the write role can answer the question",
    async () => {
      const { executionId, workItemId, questionId } = await startWaitingRun();
      const commenter = await memberWith("write");

      await unwrapAsync(
        answerRoute(executionId, questionId, "Safari 17", commenter),
      );

      expect(await questionStatus(workItemId, questionId)).toBe("answered");
      expect((await harness.getRun(executionId)).runStatus).toBe("active");
    },
    30_000,
  );

  serialTest(
    "the question waits on the work item's creator and the run's starter, not on other members",
    async () => {
      const { workItemId } = await startWaitingRun();
      const commenter = await memberWith("read");

      const [question] = await listQuestions(workItemId, commenter);

      expect(question).toMatchObject({ status: "open", waitingOnYou: false });
      expect(question?.waitingOn.map((each) => each.userId)).toEqual([
        harness.requireSetup().userId,
      ]);
    },
    30_000,
  );

  serialTest(
    "a comment that doesn't reply to the question leaves the run waiting",
    async () => {
      const { executionId, workItemId, questionId } = await startWaitingRun();

      await unwrapAsync(postComment({ workItemId, body: "Any update?" }));

      expect(await questionStatus(workItemId, questionId)).toBe("open");
      expect((await harness.getRun(executionId)).runStatus).toBe("waiting");
    },
    30_000,
  );

  serialTest(
    "answering a question that's no longer needed is refused and saves nothing",
    async () => {
      const { executionId, workItemId, questionId } = await startWaitingRun();
      await unwrapAsync(
        harness.apiClient.api["pipeline-executions"]({
          pipelineExecutionId: executionId,
        }).cancel.put(undefined, { headers: headers() }),
      );
      expect(await questionStatus(workItemId, questionId)).toBe("not_needed");
      const before = await harness.getRun(executionId);
      expect(before.waitingFor).toBeNull();

      const answered = await answerRoute(
        executionId,
        questionId,
        "Firefox, sorry for the delay",
      );

      expect(answered.data).toBeNull();
      expect(answered.error?.status).toBe(422);
      expect(answered.error?.value).toMatchObject({
        code: "PIPELINE_RUN_QUESTION_NOT_OPEN",
      });
      expect(await listComments(workItemId)).toHaveLength(1);
      expect(await questionStatus(workItemId, questionId)).toBe("not_needed");
      const after = await harness.getRun(executionId);
      expect(after.runStatus).toBe("cancelled");
      expect(after.visits).toEqual(before.visits);
      expect(await harness.claim(workItemId)).toEqual([]);
    },
    30_000,
  );

  serialTest(
    "answering an unknown question is a 404",
    async () => {
      const { executionId } = await startWaitingRun();

      const answered = await answerRoute(
        executionId,
        parseUuidV7(Bun.randomUUIDv7()),
        "Chrome",
      );

      expect(answered.data).toBeNull();
      expect(answered.error?.status).toBe(404);
    },
    30_000,
  );

  serialTest(
    "listing a work item's questions needs comments:read",
    async () => {
      const { workItemId } = await startWaitingRun();
      const outsider = await createTestUserAndSession({
        email: `questions-outsider-${crypto.randomUUID()}@example.com`,
      });

      const listed = await harness.apiClient.api["work-items"]({
        workItemId,
      }).questions.get({ headers: { ...outsider.authHeaders } });

      expect(listed.data).toBeNull();
      expect(listed.error?.status).toBe(403);
    },
    30_000,
  );

  serialTest(
    "listing questions for an unknown work item is a 404",
    async () => {
      const listed = await harness.apiClient.api["work-items"]({
        workItemId: parseUuidV7(Bun.randomUUIDv7()),
      }).questions.get({ headers: headers() });

      expect(listed.data).toBeNull();
      expect(listed.error?.status).toBe(404);
    },
  );
});

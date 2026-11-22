import { beforeAll, describe, expect } from "bun:test";
import { serialTest, unwrapAsync } from "tests/utils";
import { createQuestionHarness } from "./question-test-support";

describe("pipeline execution questions: continue and guards", () => {
  const {
    harness,
    headers,
    listQuestions,
    listComments,
    continueRoute,
    startWaitingRun,
    questionStatus,
    memberWith,
  } = createQuestionHarness("pipeline-run-question-commands");

  beforeAll(async () => {
    await harness.setUp();
  });

  serialTest(
    "continuing without a reply resumes the run with no reply, once",
    async () => {
      const { executionId, workItemId, questionId } = await startWaitingRun();

      const continued = await continueRoute(executionId, questionId);
      expect(continued.error).toBeNull();
      expect(continued.data).toMatchObject({
        runStatus: "active",
        waitingFor: null,
      });
      expect(
        continued.data?.visits.find(
          (visit) => visit.nodeId === "ask-for-details",
        ),
      ).toMatchObject({
        status: "succeeded",
        result: { replied: false, body: null, commentId: null },
      });
      expect(await questionStatus(workItemId, questionId)).toBe("answered");

      const task = await harness.getTaskRun(
        (await harness.claimOne(workItemId)).taskId,
      );
      expect(task.inputJson).toMatchObject({ reply: null });

      const again = await continueRoute(executionId, questionId);
      expect(again.data).toBeNull();
      expect(again.error?.status).toBe(422);
      expect(again.error?.value).toMatchObject({
        code: "PIPELINE_RUN_QUESTION_NOT_OPEN",
      });
    },
    30_000,
  );

  serialTest(
    "continuing without a reply needs executions:write",
    async () => {
      const { executionId, workItemId, questionId } = await startWaitingRun();
      const reader = await memberWith("read");

      const continued = await continueRoute(executionId, questionId, reader);

      expect(continued.data).toBeNull();
      expect(continued.error?.status).toBe(403);
      expect(await questionStatus(workItemId, questionId)).toBe("open");
    },
    30_000,
  );

  serialTest(
    "an open question's comment can't be edited or deleted",
    async () => {
      const { executionId, workItemId, questionId, commentId } =
        await startWaitingRun();
      const commentRoutes = harness.apiClient.api["work-item-comments"]({
        commentId,
      });

      const edited = await commentRoutes.patch(
        { body: "edited" },
        { headers: headers() },
      );
      expect(edited.error?.status).toBe(422);
      expect(edited.error?.value).toMatchObject({
        code: "WORK_ITEM_COMMENT_QUESTION_OPEN",
      });
      const deleted = await commentRoutes.delete(undefined, {
        headers: headers(),
      });
      expect(deleted.error?.status).toBe(422);
      expect(deleted.error?.value).toMatchObject({
        code: "WORK_ITEM_COMMENT_QUESTION_OPEN",
      });
      expect(await listComments(workItemId)).toHaveLength(1);

      await unwrapAsync(continueRoute(executionId, questionId));
      expect(
        await unwrapAsync(
          commentRoutes.delete(undefined, { headers: headers() }),
        ),
      ).toBe(1);
      expect(await listComments(workItemId)).toHaveLength(0);
      expect(await listQuestions(workItemId)).toEqual([]);
    },
    30_000,
  );
});

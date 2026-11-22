import { beforeAll, describe, expect } from "bun:test";
import type { PipelineDocument } from "@scarn/sdk/contracts/pipeline-document";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { serialTest, unwrapAsync } from "tests/utils";
import type { Claim } from "./pipeline-run-test-support";
import { createQuestionHarness } from "./question-test-support";

describe("pipeline execution yields: a step hands the conversation over", () => {
  const { harness, headers, listComments } = createQuestionHarness(
    "pipeline-run-yields",
  );

  beforeAll(async () => {
    await harness.setUp();
  });

  const yieldDocument = (): PipelineDocument => ({
    schemaVersion: 1,
    key: harness.uniqueKey("yields"),
    start: { to: "evaluate" },
    nodes: {
      evaluate: {
        kind: "step",
        step: harness.requireSetup().stepKey,
        next: {
          routes: [{ to: "done" }],
        },
      },
      done: { kind: "succeed" },
    },
  });

  const yieldTask = (
    claimed: Claim,
    body: {
      message: string;
      workBranch?: string | null;
      createdFromBranch?: string | null;
      sessionObjectKey?: string | null;
      sessionRestored?: boolean | null;
    },
  ) =>
    harness.apiClient.api["task-runs"]({
      taskRunId: claimed.taskId,
    }).yields.post(
      { claimToken: claimed.claimToken, ...body },
      { headers: headers() },
    );

  serialTest(
    "a hand-off parks the Task, opens a conversation with the agent's message and waits for a reply",
    async () => {
      const started = await harness.startRun(yieldDocument());
      const workItemId = parseUuidV7(started.workItemId);
      const claimed = await harness.claimOne(workItemId);

      await unwrapAsync(
        yieldTask(claimed, {
          message: "Should the fix target v1 or v2 of the client?",
          workBranch: "scarn/evaluate-1",
        }),
      );

      const task = await harness.getTaskRun(claimed.taskId);
      expect(task.status).toBe("yielded");
      expect(task).not.toHaveProperty("yieldJson");
      const run = await harness.getRun(started.executionId);
      expect(run).toMatchObject({ runStatus: "waiting", waitingFor: "reply" });
      const visit = harness.visitOf(run, "evaluate");
      expect(visit.status).toBe("waiting");
      if (!visit.conversationId) {
        throw new Error("Expected the visit to have a conversation");
      }

      const conversation = await unwrapAsync(
        harness.apiClient.api
          .conversations({ conversationId: visit.conversationId })
          .get({ headers: headers() }),
      );
      expect(conversation).toMatchObject({
        status: "waiting_for_person",
        workItemId,
        visit: {
          pipelineExecutionId: started.executionId,
          visitId: visit.id,
          nodeId: "evaluate",
        },
        endsWith: "findings",
        closedAt: null,
      });
      expect(conversation.messages).toHaveLength(1);
      expect(conversation.messages[0]).toMatchObject({
        authorKind: "agent",
        authorName: null,
        taskRunId: claimed.taskId,
        body: "Should the fix target v1 or v2 of the client?",
      });
      expect(await listComments(workItemId)).toEqual([]);
    },
    30_000,
  );

  serialTest(
    "only the claim holder can yield",
    async () => {
      const started = await harness.startRun(yieldDocument());
      const claimed = await harness.claimOne(started.workItemId);

      const response = await yieldTask(
        { ...claimed, claimToken: "not-the-claim-token" },
        { message: "Anyone there?" },
      );
      expect(response.status).toBe(409);
      expect((await harness.getTaskRun(claimed.taskId)).status).toBe("running");
    },
    30_000,
  );
});

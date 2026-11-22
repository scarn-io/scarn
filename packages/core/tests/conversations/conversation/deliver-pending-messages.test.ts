/**
 * DB-backed coverage for delivering a conversation's pending messages.
 *
 * Placement: in neither `unit/` (it hits Postgres) nor `integration/`
 * (those must go through the API client, and delivery has no HTTP route; the
 * worker context runs it). Hand-offs and replies go through the API.
 */
import { beforeAll, describe, expect } from "bun:test";
import type { PipelineDocument } from "@scarn/sdk/contracts/pipeline-document";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { deliverPendingMessages } from "@/conversations/conversation/application/send-conversation-message";
import { serialTest, unwrapAsync } from "tests/utils";
import { createQuestionHarness } from "tests/pipeline-executions/pipeline-run/integration/question-test-support";

describe("delivering a conversation's pending messages", () => {
  const { harness, headers } = createQuestionHarness("conversation-delivery");

  beforeAll(async () => {
    await harness.setUp();
  });

  const document = (): PipelineDocument => ({
    schemaVersion: 1,
    key: harness.uniqueKey("delivery"),
    start: { to: "evaluate" },
    nodes: {
      evaluate: {
        kind: "step",
        step: harness.requireSetup().stepKey,
        next: { routes: [{ to: "done" }] },
      },
      done: { kind: "succeed" },
    },
  });

  const routes = (conversationId: UuidV7) =>
    harness.apiClient.api.conversations({ conversationId });

  const deliver = async (conversationId: UuidV7, taskRunId: UuidV7) =>
    await getDb().transaction(
      async (tx) =>
        await deliverPendingMessages(
          conversationId,
          taskRunId,
          harness.appContext,
          tx,
        ),
    );

  const startHandedOverRun = async () => {
    const started = await harness.startRun(document());
    const workItemId = parseUuidV7(started.workItemId);
    const claimed = await harness.claimOne(workItemId);
    await unwrapAsync(
      harness.apiClient.api["task-runs"]({
        taskRunId: claimed.taskId,
      }).yields.post(
        {
          claimToken: claimed.claimToken,
          message: "Should the fix target v1 or v2?",
        },
        { headers: headers() },
      ),
    );
    const { conversationId } = harness.visitOf(
      await harness.getRun(started.executionId),
      "evaluate",
    );
    if (!conversationId) {
      throw new Error("Expected a conversation");
    }
    return { workItemId, conversationId, yieldedTaskId: claimed.taskId };
  };

  serialTest(
    "hands the replies to the continuation, gives the agent the floor, and refuses a later reply",
    async () => {
      const { workItemId, conversationId } = await startHandedOverRun();
      await unwrapAsync(
        routes(conversationId).messages.post(
          { body: "Target v2." },
          { headers: headers() },
        ),
      );
      await unwrapAsync(
        routes(conversationId).messages.post(
          { body: "Keep the old flag." },
          { headers: headers() },
        ),
      );
      const continuation = await harness.claimOne(workItemId);

      const delivered = await deliver(conversationId, continuation.taskId);
      expect(
        delivered.map((message) => ({
          authorKind: message.authorKind,
          body: message.body,
          deliveredToTaskRunId: message.deliveredToTaskRunId,
        })),
      ).toEqual([
        {
          authorKind: "person",
          body: "Target v2.",
          deliveredToTaskRunId: continuation.taskId,
        },
        {
          authorKind: "person",
          body: "Keep the old flag.",
          deliveredToTaskRunId: continuation.taskId,
        },
      ]);
      const conversation = await unwrapAsync(
        routes(conversationId).get({ headers: headers() }),
      );
      expect(conversation.status).toBe("agent_turn");

      const late = await routes(conversationId).messages.post(
        { body: "One more thing." },
        { headers: headers() },
      );
      expect(late.status).toBe(409);
      expect(late.error?.value).toMatchObject({
        code: "CONVERSATION_NOT_WAITING",
      });
      expect(await deliver(conversationId, continuation.taskId)).toEqual([]);
    },
    30_000,
  );

  serialTest(
    "delivers a continue-without-reply's system message",
    async () => {
      const { workItemId, conversationId } = await startHandedOverRun();
      await unwrapAsync(
        routes(conversationId).continue.post(undefined, {
          headers: headers(),
        }),
      );
      const continuation = await harness.claimOne(workItemId);

      const delivered = await deliver(conversationId, continuation.taskId);
      expect(delivered.map((message) => message.authorKind)).toEqual([
        "system",
      ]);
    },
    30_000,
  );

  serialTest(
    "delivers nothing while the agent waits for a person",
    async () => {
      const { conversationId, yieldedTaskId } = await startHandedOverRun();

      expect(await deliver(conversationId, yieldedTaskId)).toEqual([]);
      expect(
        (await unwrapAsync(routes(conversationId).get({ headers: headers() })))
          .status,
      ).toBe("waiting_for_person");
    },
    30_000,
  );
});

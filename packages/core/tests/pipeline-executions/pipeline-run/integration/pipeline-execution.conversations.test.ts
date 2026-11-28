import { beforeAll, describe, expect } from "bun:test";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { serialTest, unwrapAsync } from "tests/utils";
import { createConversationHarness } from "./conversation-test-support";

describe("pipeline execution conversations: a step visit talks with people", () => {
  const {
    harness,
    headers,
    listComments,
    memberWith,
    setUp,
    requireConversationStepKey,
    yieldTask,
    routes,
    getConversation,
    reply,
    continueWithoutReply,
    done,
    startHandedOverRun,
  } = createConversationHarness("pipeline-run-conversations");

  beforeAll(async () => {
    await setUp();
  });

  const queuedTasks = async (executionId: UuidV7) =>
    harness
      .visitOf(await harness.getRun(executionId), "evaluate")
      .tasks.filter((task) => task.status === "queued");

  serialTest(
    "a hand-off opens a conversation holding the agent's message, and the run waits for a reply",
    async () => {
      const { executionId, workItemId, claimed, visitId, conversationId } =
        await startHandedOverRun();

      expect(await harness.getRun(executionId)).toMatchObject({
        runStatus: "waiting",
        waitingFor: "reply",
      });
      const conversation = await getConversation(conversationId);
      expect(conversation).toMatchObject({
        id: conversationId,
        projectId: harness.requireSetup().projectId,
        workItemId,
        status: "waiting_for_person",
        visit: {
          pipelineExecutionId: executionId,
          visitId,
          nodeId: "evaluate",
        },
        endsWith: "findings",
        closedAt: null,
      });
      expect(conversation.messages).toEqual([
        {
          id: expect.any(String) as UuidV7,
          authorKind: "agent",
          authorName: null,
          taskRunId: claimed.taskId,
          body: "Should the fix target v1 or v2 of the client?",
          grantRequestId: null,
          createdAt: expect.any(String) as string,
        },
      ]);
    },
    30_000,
  );

  serialTest(
    "two replies queue one continuation, and neither touches the work item's comments",
    async () => {
      const { executionId, workItemId, conversationId } =
        await startHandedOverRun();

      const first = await unwrapAsync(
        reply(conversationId, "Target v2; v1 is deprecated."),
      );
      expect(first.status).toBe("reply_pending");
      expect((await harness.getRun(executionId)).runStatus).toBe("active");
      const second = await unwrapAsync(
        reply(conversationId, "And keep the old flag working."),
      );
      expect(second.status).toBe("reply_pending");

      expect(await queuedTasks(executionId)).toHaveLength(1);
      expect(
        second.messages.map((message) => [message.authorKind, message.body]),
      ).toEqual([
        ["agent", "Should the fix target v1 or v2 of the client?"],
        ["person", "Target v2; v1 is deprecated."],
        ["person", "And keep the old flag working."],
      ]);
      expect(second.messages[1]?.authorName).toBeString();
      expect(await listComments(workItemId)).toEqual([]);
    },
    30_000,
  );

  serialTest(
    "continuing without a reply posts a system message and queues the next turn, only while waiting",
    async () => {
      const { executionId, conversationId } = await startHandedOverRun();

      const continued = await unwrapAsync(continueWithoutReply(conversationId));
      expect(continued.status).toBe("reply_pending");
      expect(continued.messages.at(-1)).toMatchObject({
        authorKind: "system",
        body: expect.stringMatching(
          /^.+ chose to continue without a reply$/,
        ) as string,
      });
      expect(await queuedTasks(executionId)).toHaveLength(1);

      const again = await continueWithoutReply(conversationId);
      expect(again.status).toBe(409);
      expect(again.error?.value).toMatchObject({
        code: "CONVERSATION_NOT_WAITING",
      });
      expect(await queuedTasks(executionId)).toHaveLength(1);
    },
    30_000,
  );

  serialTest(
    "ending the visit closes the conversation, and a later reply is refused",
    async () => {
      const { executionId, workItemId, conversationId } =
        await startHandedOverRun();
      await unwrapAsync(reply(conversationId, "Target v2."));

      await harness.complete(await harness.claimOne(workItemId), "succeeded");
      expect((await harness.getRun(executionId)).runStatus).toBe("succeeded");
      const conversation = await getConversation(conversationId);
      expect(conversation.status).toBe("closed");
      expect(conversation.closedAt).not.toBeNull();

      const late = await reply(conversationId, "One more thing.");
      expect(late.status).toBe(409);
      expect(late.error?.value).toMatchObject({
        code: "CONVERSATION_NOT_WAITING",
      });
      expect(
        (await getConversation(conversationId)).messages.map(
          (message) => message.body,
        ),
      ).not.toContain("One more thing.");
    },
    30_000,
  );

  serialTest(
    "a second hand-off in the same visit continues the same conversation",
    async () => {
      const { executionId, workItemId, conversationId } =
        await startHandedOverRun();
      await unwrapAsync(reply(conversationId, "Target v2."));

      await yieldTask(
        await harness.claimOne(workItemId),
        "Should the old flag keep working?",
      );
      const visit = harness.visitOf(
        await harness.getRun(executionId),
        "evaluate",
      );
      expect(visit.conversationId).toBe(conversationId);
      const conversation = await getConversation(conversationId);
      expect(conversation.status).toBe("waiting_for_person");
      expect(conversation.messages.map((message) => message.body)).toEqual([
        "Should the fix target v1 or v2 of the client?",
        "Target v2.",
        "Should the old flag keep working?",
      ]);
    },
    30_000,
  );

  serialTest(
    "a work item lists its conversations with their status, node, last message time and messages",
    async () => {
      const { workItemId, conversationId, executionId, visitId } =
        await startHandedOverRun();
      await unwrapAsync(reply(conversationId, "Target v2."));
      const conversation = await getConversation(conversationId);

      const listed = await unwrapAsync(
        harness.apiClient.api["work-items"]({ workItemId }).conversations.get({
          headers: headers(),
        }),
      );
      expect(listed).toEqual([
        {
          id: conversationId,
          status: "reply_pending",
          nodeId: "evaluate",
          pipelineExecutionId: executionId,
          visitId,
          lastMessageAt: conversation.messages.at(-1)?.createdAt ?? null,
          messages: conversation.messages,
          createdAt: conversation.createdAt,
        },
      ]);
    },
    30_000,
  );

  serialTest(
    "replying needs comments:write, and continuing or ending needs executions:write",
    async () => {
      const { conversationId } = await startHandedOverRun(
        requireConversationStepKey(),
      );
      const reader = await memberWith("read");
      const commenter = await memberWith("write");

      expect((await reply(conversationId, "Hi.", reader)).status).toBe(403);
      expect((await continueWithoutReply(conversationId, reader)).status).toBe(
        403,
      );
      expect((await done(conversationId, reader)).status).toBe(403);
      expect((await getConversation(conversationId)).status).toBe(
        "waiting_for_person",
      );

      const replied = await unwrapAsync(
        reply(conversationId, "Target v2.", commenter),
      );
      expect(replied.status).toBe("reply_pending");
    },
    30_000,
  );

  serialTest(
    "an unknown conversation is not found",
    async () => {
      const response = await routes(
        parseUuidV7("01900000-0000-7000-8000-000000000000"),
      ).get({ headers: headers() });
      expect(response.status).toBe(404);
    },
    30_000,
  );
});

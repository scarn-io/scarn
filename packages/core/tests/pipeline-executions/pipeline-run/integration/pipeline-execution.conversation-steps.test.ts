import { beforeAll, describe, expect } from "bun:test";
import { serialTest, unwrapAsync } from "tests/utils";
import { createConversationHarness } from "./conversation-test-support";

describe("pipeline execution conversation steps: a step visit that ends in conversation", () => {
  const {
    harness,
    headers,
    setUp,
    requireConversationStepKey,
    documentFor,
    getConversation,
    reply,
    done,
    startHandedOverRun,
  } = createConversationHarness("pipeline-run-conversation-steps");

  beforeAll(async () => {
    await setUp();
  });

  serialTest(
    "Done on a conversation step succeeds the visit with the last agent message as its summary",
    async () => {
      const { executionId, conversationId } = await startHandedOverRun(
        requireConversationStepKey(),
        "Here's the plan: ship v2 behind a flag.",
      );
      expect((await getConversation(conversationId)).endsWith).toBe(
        "conversation",
      );

      const ended = await unwrapAsync(done(conversationId));
      expect(ended.status).toBe("closed");
      expect(ended.messages.at(-1)).toMatchObject({
        authorKind: "system",
        body: expect.stringMatching(/^.+ ended the conversation$/) as string,
      });
      const run = await harness.getRun(executionId);
      expect(run.runStatus).toBe("succeeded");
      expect(harness.visitOf(run, "evaluate")).toMatchObject({
        status: "succeeded",
        result: {
          conversationId,
          summary: "Here's the plan: ship v2 behind a flag.",
        },
      });
    },
    30_000,
  );

  serialTest(
    "Done is refused on a step with a result schema, and when the conversation isn't waiting",
    async () => {
      const { executionId, conversationId } = await startHandedOverRun();

      const refused = await done(conversationId);
      expect(refused.status).toBe(422);
      expect(refused.error?.value).toMatchObject({
        code: "CONVERSATION_STEP_HAS_RESULT_SCHEMA",
      });
      const conversation = await getConversation(conversationId);
      expect(conversation.status).toBe("waiting_for_person");
      expect(
        conversation.messages.map((message) => message.authorKind),
      ).toEqual(["agent"]);
      expect((await harness.getRun(executionId)).runStatus).toBe("waiting");

      const conversationStep = await startHandedOverRun(
        requireConversationStepKey(),
      );
      await unwrapAsync(reply(conversationStep.conversationId, "Go on."));
      const notWaiting = await done(conversationStep.conversationId);
      expect(notWaiting.status).toBe(409);
      expect(notWaiting.error?.value).toMatchObject({
        code: "CONVERSATION_NOT_WAITING",
      });
    },
    30_000,
  );

  serialTest(
    "completing a conversation step's Task posts its closing message and stores the conversation and summary",
    async () => {
      const { executionId, workItemId, conversationId } =
        await startHandedOverRun(requireConversationStepKey());
      await unwrapAsync(reply(conversationId, "Ship it behind a flag."));
      const continuation = await harness.claimOne(workItemId);

      await harness.complete(continuation, "succeeded", {
        summary: "  Agreed: v2 ships behind a flag.  ",
      });

      const run = await harness.getRun(executionId);
      expect(run.runStatus).toBe("succeeded");
      const visit = harness.visitOf(run, "evaluate");
      expect(visit.result).toEqual({
        conversationId,
        summary: "Agreed: v2 ships behind a flag.",
      });
      expect(
        (await harness.getTaskRun(continuation.taskId)).resultJson,
      ).toEqual({
        conversationId,
        summary: "Agreed: v2 ships behind a flag.",
      });
      const conversation = await getConversation(conversationId);
      expect(conversation.status).toBe("closed");
      expect(conversation.messages.at(-1)).toMatchObject({
        authorKind: "agent",
        taskRunId: continuation.taskId,
        body: "Agreed: v2 ships behind a flag.",
      });
    },
    30_000,
  );

  serialTest(
    "a conversation step that ends on its first turn still gets a conversation, with no message for an empty summary",
    async () => {
      const started = await harness.startRun(
        documentFor(requireConversationStepKey()),
      );
      await harness.complete(
        await harness.claimOne(started.workItemId),
        "succeeded",
        { summary: "   " },
      );

      const visit = harness.visitOf(
        await harness.getRun(started.executionId),
        "evaluate",
      );
      expect(visit.status).toBe("succeeded");
      if (!visit.conversationId) {
        throw new Error("Expected a conversation");
      }
      expect(visit.result).toEqual({
        conversationId: visit.conversationId,
        summary: "",
      });
      expect(await getConversation(visit.conversationId)).toMatchObject({
        status: "closed",
        messages: [],
      });
    },
    30_000,
  );

  serialTest(
    "a code step definition without a result schema is refused",
    async () => {
      const response = await harness.apiClient.api["step-definitions"].post(
        {
          projectId: harness.requireSetup().projectId,
          key: `code-${crypto.randomUUID()}`,
          name: "Code step",
          description: null,
          version: 1,
          kind: "code",
          entrypointJson: { sourceFile: ".scarn/pipeline-builder/step.ts" },
          inputSchemaJson: { type: "object" },
          resultSchemaJson: null,
          status: "draft",
        },
        { headers: headers() },
      );
      expect(response.status).toBe(422);
      expect(response.error?.value).toMatchObject({
        code: "STEP_DEFINITION_RESULT_SCHEMA_REQUIRED",
      });
    },
    30_000,
  );
});

import { beforeAll, describe, expect } from "bun:test";
import { serialTest, unwrapAsync } from "tests/utils";
import type { Claim } from "./pipeline-run-test-support";
import { createConversationHarness } from "./conversation-test-support";

const NO_ANSWER_TEXT =
  "No answer is coming. Make the call yourself and record your assumption in your result.";

describe("pipeline execution conversation context: a continuation receives its conversation", () => {
  const {
    harness,
    headers,
    setUp,
    requireConversationStepKey,
    documentFor,
    getConversation,
    reply,
    continueWithoutReply,
    startHandedOverRun,
  } = createConversationHarness("pipeline-run-conversation-context");

  beforeAll(async () => {
    await setUp();
  });

  const workerContext = async (claimed: Claim) =>
    await unwrapAsync(
      harness.apiClient.api["task-runs"]({ taskRunId: claimed.taskId })[
        "worker-context"
      ].post({ claimToken: claimed.claimToken }, { headers: headers() }),
    );

  serialTest(
    "fetching the continuation's context delivers the replies, gives the agent the floor, and refuses a later reply",
    async () => {
      const { workItemId, conversationId } = await startHandedOverRun();
      await unwrapAsync(reply(conversationId, "Target v2; v1 is deprecated."));
      const continuation = await harness.claimOne(workItemId);

      expect((await getConversation(conversationId)).status).toBe(
        "reply_pending",
      );
      await workerContext(continuation);
      expect((await getConversation(conversationId)).status).toBe("agent_turn");

      const late = await reply(conversationId, "One more thing.");
      expect(late.status).toBe(409);
      expect(late.error?.value).toMatchObject({
        code: "CONVERSATION_NOT_WAITING",
      });
    },
    30_000,
  );

  serialTest(
    "the fallback prompt lists the conversation so far, oldest first",
    async () => {
      const { workItemId, conversationId } = await startHandedOverRun();
      await unwrapAsync(reply(conversationId, "Target v2; v1 is deprecated."));
      await unwrapAsync(reply(conversationId, "Keep the old flag working."));
      const author = (await getConversation(conversationId)).messages.find(
        (message) => message.authorKind === "person",
      )?.authorName;
      const continuation = await harness.claimOne(workItemId);

      const { promptText } = (await workerContext(continuation)).agentPrompt;
      expect(promptText).toContain(
        [
          "The conversation so far, oldest first:",
          "Scarn (you):",
          "    Should the fix target v1 or v2 of the client?",
          `${String(author)}:`,
          "    Target v2; v1 is deprecated.",
          `${String(author)}:`,
          "    Keep the old flag working.",
          "",
        ].join("\n"),
      );
      expect(promptText).toContain(
        "This run continues the previous run of this step (status: yielded).",
      );
      expect(promptText).not.toContain(NO_ANSWER_TEXT);
    },
    30_000,
  );

  serialTest(
    "a continue without a reply tells the fallback prompt no answer is coming",
    async () => {
      const { workItemId, conversationId } = await startHandedOverRun();
      await unwrapAsync(continueWithoutReply(conversationId));
      const continuation = await harness.claimOne(workItemId);

      const { promptText } = (await workerContext(continuation)).agentPrompt;
      expect(promptText).toContain(
        [
          "The conversation so far, oldest first:",
          "Scarn (you):",
          "    Should the fix target v1 or v2 of the client?",
          NO_ANSWER_TEXT,
        ].join("\n"),
      );
      expect(promptText).not.toContain("chose to continue without a reply");
    },
    30_000,
  );

  serialTest(
    "a first attempt's prompt has no conversation, and tells it how to hand back",
    async () => {
      const started = await harness.startRun(
        documentFor(harness.requireSetup().stepKey),
      );
      const claimed = await harness.claimOne(started.workItemId);

      const context = await workerContext(claimed);
      expect(context.task.turnsRemaining).toBeGreaterThan(0);
      expect(context.agentPrompt.promptText).not.toContain(
        "The conversation so far",
      );
      expect(context.agentPrompt.promptText).toContain(
        "`scarn-submit-step-findings`",
      );
      expect(context.agentPrompt.promptText).toContain(
        "If you're done, submit your findings.",
      );
      expect(context.agentPrompt.promptText).toMatch(
        /You can hand back \d+ more times?\.$/,
      );
    },
    30_000,
  );

  serialTest(
    "a conversation step's prompt has no findings section",
    async () => {
      const { workItemId, conversationId } = await startHandedOverRun(
        requireConversationStepKey(),
        "Here's the plan: ship v2 behind a flag.",
      );
      await unwrapAsync(reply(conversationId, "Sounds good."));
      const continuation = await harness.claimOne(workItemId);

      const { promptText } = (await workerContext(continuation)).agentPrompt;
      expect(promptText).not.toContain("scarn-submit-step-findings");
      expect(promptText).not.toContain("findings result schema");
      expect(promptText).toContain(
        "This step is a conversation; there are no findings to submit.",
      );
      expect(promptText).toContain("    Sounds good.");
    },
    30_000,
  );
});

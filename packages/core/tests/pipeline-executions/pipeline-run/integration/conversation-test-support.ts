import type { PipelineDocument } from "@scarn/sdk/contracts/pipeline-document";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { buildAgentStepDefinitionPayload } from "tests/pipeline-definitions/pipeline-test-support";
import { unwrapAsync } from "tests/utils";
import type { Claim } from "./pipeline-run-test-support";
import { createQuestionHarness } from "./question-test-support";

/**
 * A question harness plus the conversation calls: a one-step pipeline, a
 * conversation step definition (no result schema), a run whose first
 * attempt hands over, and the conversation routes.
 */
export const createConversationHarness = (name: string) => {
  const questionHarness = createQuestionHarness(name);
  const { harness, headers } = questionHarness;
  let conversationStepKey: string | undefined;

  const setUp = async () => {
    await harness.setUp();
    const stepDefinition = await unwrapAsync(
      harness.apiClient.api["step-definitions"].post(
        {
          ...buildAgentStepDefinitionPayload(harness.requireSetup().projectId),
          resultSchemaJson: null,
        },
        { headers: headers() },
      ),
    );
    if (stepDefinition.resultSchemaJson !== null) {
      throw new Error("Expected a conversation step definition");
    }
    conversationStepKey = stepDefinition.key;
  };

  const requireConversationStepKey = () => {
    if (!conversationStepKey) {
      throw new Error("Expected setup to complete");
    }
    return conversationStepKey;
  };

  const documentFor = (stepKey: string): PipelineDocument => ({
    schemaVersion: 1,
    key: harness.uniqueKey("conversations"),
    start: { to: "evaluate" },
    nodes: {
      evaluate: {
        kind: "step",
        step: stepKey,
        next: { routes: [{ to: "done" }] },
      },
      done: { kind: "succeed" },
    },
  });

  const yieldTask = async (claimed: Claim, message: string) =>
    await unwrapAsync(
      harness.apiClient.api["task-runs"]({
        taskRunId: claimed.taskId,
      }).yields.post(
        {
          claimToken: claimed.claimToken,
          message,
          workBranch: "scarn/evaluate-1",
        },
        { headers: headers() },
      ),
    );

  const routes = (conversationId: UuidV7) =>
    harness.apiClient.api.conversations({ conversationId });

  const getConversation = async (conversationId: UuidV7) =>
    await unwrapAsync(routes(conversationId).get({ headers: headers() }));

  const reply = (
    conversationId: UuidV7,
    body: string,
    authHeaders = headers(),
  ) => routes(conversationId).messages.post({ body }, { headers: authHeaders });

  const continueWithoutReply = (
    conversationId: UuidV7,
    authHeaders = headers(),
  ) =>
    routes(conversationId).continue.post(undefined, { headers: authHeaders });

  const done = (conversationId: UuidV7, authHeaders = headers()) =>
    routes(conversationId).done.post(undefined, { headers: authHeaders });

  /** Starts a run of `stepKey` whose first attempt hands the conversation over. */
  const startHandedOverRun = async (
    stepKey = harness.requireSetup().stepKey,
    message = "Should the fix target v1 or v2 of the client?",
  ) => {
    const started = await harness.startRun(documentFor(stepKey));
    const executionId = started.executionId;
    const workItemId = parseUuidV7(started.workItemId);
    const claimed = await harness.claimOne(workItemId);
    await yieldTask(claimed, message);
    const visit = harness.visitOf(
      await harness.getRun(executionId),
      "evaluate",
    );
    if (!visit.conversationId) {
      throw new Error("Expected a conversation");
    }
    return {
      executionId,
      workItemId,
      claimed,
      visitId: visit.id,
      conversationId: visit.conversationId,
    };
  };

  return {
    ...questionHarness,
    setUp,
    requireConversationStepKey,
    documentFor,
    yieldTask,
    routes,
    getConversation,
    reply,
    continueWithoutReply,
    done,
    startHandedOverRun,
  };
};

import { beforeAll, describe, expect } from "bun:test";
import type { PipelineDocument } from "@scarn/sdk/contracts/pipeline-document";
import type { ObjectStore } from "@/artifacts/object-store";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { serialTest, unwrapAsync } from "tests/utils";
import type { Claim } from "./pipeline-run-test-support";
import { createQuestionHarness } from "./question-test-support";

/** Presigns deterministic URLs and records every deleted key. */
const trackingObjectStore = () => {
  const deletedKeys: string[] = [];
  const store: ObjectStore = {
    putObject: () => Promise.resolve({ sizeBytes: 0 }),
    getObject: () => Promise.resolve(null),
    getObjectStream: () => Promise.resolve(null),
    getPresignedGetUrl: (key: string) =>
      Promise.resolve(`https://store.test/get/${key}`),
    getPresignedPutUrl: (key: string) =>
      Promise.resolve(`https://store.test/put/${key}`),
    deleteObject: (key: string) => {
      deletedKeys.push(key);
      return Promise.resolve();
    },
    deletePrefix: () => Promise.resolve({ deletedCount: 0 }),
  };
  return { store, deletedKeys };
};

describe("pipeline execution saved sessions: a yield saves the agent session and the reply restores it", () => {
  const objectStore = trackingObjectStore();
  const { harness, headers } = createQuestionHarness(
    "pipeline-run-saved-sessions",
    { objectStore: objectStore.store },
  );

  beforeAll(async () => {
    await harness.setUp();
  });

  const yieldDocument = (): PipelineDocument => ({
    schemaVersion: 1,
    key: harness.uniqueKey("saved-sessions"),
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

  const sessionUploadUrl = (claimed: Claim) =>
    harness.apiClient.api["task-runs"]({ taskRunId: claimed.taskId })[
      "session-upload-url"
    ].post(
      { claimToken: claimed.claimToken, sizeBytes: 128 },
      { headers: headers() },
    );

  const yieldTask = (claimed: Claim, sessionObjectKey: string | null) =>
    harness.apiClient.api["task-runs"]({
      taskRunId: claimed.taskId,
    }).yields.post(
      {
        claimToken: claimed.claimToken,
        message: "Should the fix target v1 or v2?",
        workBranch: "scarn/evaluate-1",
        createdFromBranch: "main",
        sessionObjectKey,
        sessionRestored: null,
      },
      { headers: headers() },
    );

  const workerContext = async (claimed: Claim) =>
    await unwrapAsync(
      harness.apiClient.api["task-runs"]({ taskRunId: claimed.taskId })[
        "worker-context"
      ].post({ claimToken: claimed.claimToken }, { headers: headers() }),
    );

  const conversationRoutes = (conversationId: UuidV7) =>
    harness.apiClient.api.conversations({ conversationId });

  const personNameOf = async (conversationId: UuidV7) => {
    const conversation = await unwrapAsync(
      conversationRoutes(conversationId).get({ headers: headers() }),
    );
    const person = conversation.messages.find(
      (message) => message.authorKind === "person",
    );
    if (!person?.authorName) {
      throw new Error("Expected a person message with an author");
    }
    return person.authorName;
  };

  const sessionKeyOf = (taskId: UuidV7) => `tasks/${taskId}/session.json`;

  const conversationIdOf = async (executionId: UuidV7) => {
    const { conversationId } = harness.visitOf(
      await harness.getRun(executionId),
      "evaluate",
    );
    if (!conversationId) {
      throw new Error("Expected a conversation");
    }
    return conversationId;
  };

  /** Starts a run whose first attempt yields, saving its session when `saveSession`. */
  const startYieldedRun = async ({ saveSession = true } = {}) => {
    const started = await harness.startRun(yieldDocument());
    const workItemId = parseUuidV7(started.workItemId);
    const claimed = await harness.claimOne(workItemId);
    const upload = await unwrapAsync(sessionUploadUrl(claimed));
    await unwrapAsync(
      yieldTask(claimed, saveSession ? upload.objectKey : null),
    );
    return {
      executionId: started.executionId,
      workItemId,
      claimed,
      upload,
      conversationId: await conversationIdOf(started.executionId),
    };
  };

  serialTest(
    "the upload URL is minted for the claim holder at the Task's session key",
    async () => {
      const started = await harness.startRun(yieldDocument());
      const claimed = await harness.claimOne(started.workItemId);

      const upload = await unwrapAsync(sessionUploadUrl(claimed));
      expect(upload).toEqual({
        uploadUrl: `https://store.test/put/${sessionKeyOf(claimed.taskId)}`,
        objectKey: sessionKeyOf(claimed.taskId),
        expiresInSeconds: 900,
      });

      const stranger = await sessionUploadUrl({
        ...claimed,
        claimToken: "not-the-claim-token",
      });
      expect(stranger.status).toBe(409);
    },
    30_000,
  );

  serialTest(
    "a yield naming another object key is rejected",
    async () => {
      const started = await harness.startRun(yieldDocument());
      const claimed = await harness.claimOne(started.workItemId);

      const response = await yieldTask(claimed, "tasks/someone-else.json");
      expect(response.status).toBe(422);
      expect(response.error?.value).toMatchObject({
        code: "TASK_SESSION_OBJECT_KEY_MISMATCH",
      });
      expect((await harness.getTaskRun(claimed.taskId)).status).toBe("running");
    },
    30_000,
  );

  serialTest(
    "the reply's continuation restores the saved session, and the session is deleted when the visit ends",
    async () => {
      const { executionId, workItemId, upload, conversationId } =
        await startYieldedRun();

      await unwrapAsync(
        conversationRoutes(conversationId).messages.post(
          { body: "Target v2; v1 is deprecated." },
          { headers: headers() },
        ),
      );
      await unwrapAsync(
        conversationRoutes(conversationId).messages.post(
          { body: "Keep the old flag." },
          { headers: headers() },
        ),
      );
      const author = await personNameOf(conversationId);
      const next = await harness.claimOne(workItemId);
      const context = await workerContext(next);
      const expectedRestore = {
        downloadUrl: `https://store.test/get/${upload.objectKey}`,
        message: `Reply from ${author}: Target v2; v1 is deprecated.\n\nReply from ${author}: Keep the old flag.`,
      };
      expect(context.restoreSession).toEqual(expectedRestore);
      expect((await workerContext(next)).restoreSession).toEqual(
        expectedRestore,
      );
      expect(objectStore.deletedKeys).not.toContain(upload.objectKey);

      await harness.complete(next, "succeeded");
      expect((await harness.getRun(executionId)).runStatus).toBe("succeeded");
      expect(objectStore.deletedKeys).toContain(upload.objectKey);
    },
    30_000,
  );

  serialTest(
    "continuing without a reply restores the saved session",
    async () => {
      const { workItemId, upload, conversationId } = await startYieldedRun();

      await unwrapAsync(
        conversationRoutes(conversationId).continue.post(undefined, {
          headers: headers(),
        }),
      );
      const context = await workerContext(await harness.claimOne(workItemId));
      expect(context.restoreSession).toEqual({
        downloadUrl: `https://store.test/get/${upload.objectKey}`,
        message:
          "No answer is coming. Make the call yourself and record your assumption in your result.",
      });
    },
    30_000,
  );

  serialTest(
    "a steer starts a fresh session and the superseded visit's session is deleted",
    async () => {
      const { executionId, workItemId, upload } = await startYieldedRun();
      const visit = harness.visitOf(
        await harness.getRun(executionId),
        "evaluate",
      );

      await unwrapAsync(
        harness
          .visitRoutes(executionId, visit.id)
          .messages.post(
            { body: "Start over against v3 instead." },
            { headers: headers() },
          ),
      );
      expect(objectStore.deletedKeys).toContain(upload.objectKey);

      const context = await workerContext(await harness.claimOne(workItemId));
      expect(context.restoreSession).toBeNull();
    },
    30_000,
  );

  serialTest(
    "a yield without a saved session has nothing to restore",
    async () => {
      const { workItemId, conversationId } = await startYieldedRun({
        saveSession: false,
      });

      await unwrapAsync(
        conversationRoutes(conversationId).messages.post(
          { body: "Target v2." },
          { headers: headers() },
        ),
      );
      const context = await workerContext(await harness.claimOne(workItemId));
      expect(context.restoreSession).toBeNull();
    },
    30_000,
  );
});

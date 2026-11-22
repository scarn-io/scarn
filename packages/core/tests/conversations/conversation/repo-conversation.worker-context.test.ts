/**
 * DB-backed coverage for repo conversations (chats). In neither `unit/` (it
 * hits Postgres) nor `integration/` (they also read and seed
 * the database directly; route-level tests are in `integration/`). The worker context a chat run
 * gets: the turn it answers, the fresh-session prompt and the restore.
 */
import { describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { conversationMessages, taskRuns } from "@/lib/db/schema";
import { serialTest } from "tests/utils";
import {
  createRepoConversationHarness,
  FAILURE,
  PresigningObjectStore,
} from "./repo-conversation-test-support";

const COMMIT = "a".repeat(40);

/** Presigns uploads but throws on download URLs. */
class FailingGetObjectStore extends PresigningObjectStore {
  override async getPresignedGetUrl(): Promise<string | null> {
    return await Promise.reject(new Error("store unavailable"));
  }
}

describe("repo conversations: worker context", () => {
  const {
    h,
    created,
    claim,
    answer,
    pinBaseCommit,
    fail,
    runsOf,
    reply,
    retry,
  } = createRepoConversationHarness({
    objectStore: new PresigningObjectStore(),
  });

  serialTest(
    "an initial run takes delivery of the question and gets the repo-ask instruction, not the work-item one",
    async () => {
      const chat = await created("How does checkout work?");
      const context = await h.workerContext(
        chat.taskRunId,
        await claim(chat.taskRunId),
      );

      expect(context.task.conversationId).toBe(chat.conversationId);
      expect(context.task.workItemId).toBeNull();
      expect(context.baseCommit).toBeNull();
      expect(context.previousRun).toBeNull();
      expect(context.restoreSession).toBeNull();
      const prompt = context.agentPrompt.promptText;
      expect(prompt).toContain("This conversation is advisory.");
      expect(prompt).toContain("Don't call `scarn-end-conversation`");
      expect(prompt).not.toContain("Your work item is the one");
      expect(prompt).toContain("    How does checkout work?");
      expect(prompt).toContain("Answer the last message now.");

      const conversation = await h
        .conversationRoutes(parseUuidV7(chat.conversationId))
        .get({ headers: h.requireSetup().headers });
      expect(conversation.data?.status).toBe("agent_turn");
      const delivered = await getDb()
        .select({ deliveredTo: conversationMessages.deliveredToTaskRunId })
        .from(conversationMessages)
        .where(
          eq(
            conversationMessages.conversationId,
            parseUuidV7(chat.conversationId),
          ),
        );
      expect(delivered).toEqual([{ deliveredTo: chat.taskRunId }]);
    },
  );

  serialTest(
    "a continuation restores the saved session with the current-turn preamble, and carries the fresh-session prompt",
    async () => {
      const chat = await created("How does checkout work?");
      const claimToken = await claim(chat.taskRunId);
      await unwrapPin(
        pinBaseCommit(chat.taskRunId, claimToken, COMMIT, "main"),
      );
      const { sessionObjectKey } = await answerWithSessionClaimed(
        chat.taskRunId,
        claimToken,
      );
      await reply(parseUuidV7(chat.conversationId), "Which file?");
      const continuationId = (await runsOf(chat.taskId))[1]?.id ?? "";

      const context = await h.workerContext(
        continuationId,
        await claim(continuationId),
      );

      expect(context.baseCommit).toBe(COMMIT);
      expect(context.baseWorkBranch).toBe("main");
      expect(context.restoreSession?.downloadUrl).toContain(sessionObjectKey);
      const message = context.restoreSession?.message ?? "";
      expect(message).toContain(`task run ${continuationId}`);
      expect(message).toContain(context.gitUrl);
      expect(message).toContain(`branch main, commit ${COMMIT}`);
      expect(message).toContain("This conversation is advisory.");
      expect(message).toContain("fresh checkout at the same commit");
      expect(message).toMatch(/Reply from .*: Which file\?$/);
      expect(message).not.toContain("How does checkout work?");
      const prompt = context.agentPrompt.promptText;
      expect(prompt).toContain("    How does checkout work?");
      expect(prompt).toContain("    It goes through the cart service.");
      expect(prompt).toContain("    Which file?");
    },
  );

  serialTest(
    "a continuation without a saved session falls back to the fresh transcript session",
    async () => {
      const chat = await created();
      await answer(chat.taskRunId, "It goes through the cart service.");
      await reply(parseUuidV7(chat.conversationId), "Which file?");
      const continuationId = (await runsOf(chat.taskId))[1]?.id ?? "";

      const context = await h.workerContext(
        continuationId,
        await claim(continuationId),
      );

      expect(context.restoreSession).toBeNull();
      expect(context.agentPrompt.promptText).toContain("    Which file?");
    },
  );

  serialTest(
    "a chat run's context carries no grants, so the agent gets no work-item tools",
    async () => {
      const chat = await created();

      const context = await h.workerContext(
        chat.taskRunId,
        await claim(chat.taskRunId),
      );

      expect(context.task.grants).toEqual([]);
      expect(context.task.workItemId).toBeNull();
    },
  );

  serialTest(
    "a continuation whose saved session has expired falls back to the fresh transcript session",
    async () => {
      const chat = await created();
      await answerWithSessionClaimed(
        chat.taskRunId,
        await claim(chat.taskRunId),
      );
      await reply(parseUuidV7(chat.conversationId), "Which file?");
      const longAgo = new Date("2000-01-01T00:00:00.000Z");
      await getDb()
        .update(taskRuns)
        .set({ completedAt: longAgo })
        .where(eq(taskRuns.id, parseUuidV7(chat.taskRunId)));
      const org = await h.appContext.orgRepo.findByProjectId(
        h.requireSetup().projectId,
      );
      if (!org) {
        throw new Error("Expected the project to have an org");
      }
      await h.appContext.taskRunRepo.clearExpiredSessions(
        new Date("2000-02-15T00:00:00.000Z"),
        30,
        undefined,
        org.id,
      );
      const continuationId = (await runsOf(chat.taskId))[1]?.id ?? "";

      const context = await h.workerContext(
        continuationId,
        await claim(continuationId),
      );

      expect(context.restoreSession).toBeNull();
      expect(context.agentPrompt.promptText).toContain("    Which file?");
    },
  );

  serialTest("fetching the context again keeps the same turn", async () => {
    const chat = await created();
    await answer(chat.taskRunId, "It goes through the cart service.");
    await reply(parseUuidV7(chat.conversationId), "Which file?");
    await reply(parseUuidV7(chat.conversationId), "And the tests?");
    const continuationId = (await runsOf(chat.taskId))[1]?.id ?? "";
    const claimToken = await claim(continuationId);

    const first = await h.workerContext(continuationId, claimToken);
    const second = await h.workerContext(continuationId, claimToken);

    expect(second.agentPrompt.promptText).toBe(first.agentPrompt.promptText);
    expect(first.agentPrompt.promptText).toContain(
      "Answer the last 2 messages now",
    );
  });

  serialTest(
    "a retry replays the failed turn whether or not it was delivered",
    async () => {
      const delivered = await created("How does checkout work?");
      await answer(delivered.taskRunId, "Through the cart service.");
      await reply(parseUuidV7(delivered.conversationId), "Which file?");
      const deliveredRunId = (await runsOf(delivered.taskId))[1]?.id ?? "";
      const claimToken = await claim(deliveredRunId);
      await h.workerContext(deliveredRunId, claimToken);
      await h.completeRun(deliveredRunId, claimToken, {
        status: "failed",
        errorJson: FAILURE,
      });

      const undelivered = await created("How does checkout work?");
      await answer(undelivered.taskRunId, "Through the cart service.");
      await reply(parseUuidV7(undelivered.conversationId), "Which file?");
      const undeliveredRunId = (await runsOf(undelivered.taskId))[1]?.id ?? "";
      await fail(undeliveredRunId);

      const prompts = [];
      for (const [chat, failedRunId] of [
        [delivered, deliveredRunId],
        [undelivered, undeliveredRunId],
      ] as const) {
        expect((await retry(chat.taskId, failedRunId)).status).toBe(200);
        const retryId = (await runsOf(chat.taskId))[2]?.id ?? "";
        const context = await h.workerContext(retryId, await claim(retryId));
        expect(context.restoreSession).toBeNull();
        prompts.push(context.agentPrompt.promptText);
      }
      for (const prompt of prompts) {
        expect(prompt).toContain("    Which file?");
        expect(prompt).toContain("Answer the last message now.");
      }
    },
  );

  serialTest(
    "a retry of a failed first turn replays the first question",
    async () => {
      const chat = await created("Why is the build slow?");
      await fail(chat.taskRunId);
      expect((await retry(chat.taskId, chat.taskRunId)).status).toBe(200);
      const retryId = (await runsOf(chat.taskId))[1]?.id ?? "";

      const context = await h.workerContext(retryId, await claim(retryId));

      expect(context.agentPrompt.promptText).toContain(
        "    Why is the build slow?",
      );
      expect(context.agentPrompt.promptText).toContain(
        "Answer the last message now.",
      );
    },
  );

  /** Answers with an uploaded session under a claim already held. */
  const answerWithSessionClaimed = async (
    taskRunId: string,
    claimToken: string,
  ) => {
    const routes = h.apiClient.api["task-runs"]({ taskRunId });
    const { headers } = h.requireSetup();
    await h.workerContext(taskRunId, claimToken);
    const upload = await routes["session-upload-url"].post(
      { claimToken, sizeBytes: 64 },
      { headers },
    );
    const sessionObjectKey = upload.data?.objectKey ?? "";
    await routes.yields.post(
      {
        claimToken,
        message: "It goes through the cart service.",
        sessionObjectKey,
        sessionSizeBytes: 64,
      },
      { headers },
    );
    return { sessionObjectKey };
  };
});

describe("repo conversations: worker context when presigning fails", () => {
  const { h, created, claim, answerWithSession, runsOf, reply } =
    createRepoConversationHarness({ objectStore: new FailingGetObjectStore() });

  serialTest(
    "a presign error falls back to the fresh session instead of failing the fetch",
    async () => {
      const chat = await created();
      await answerWithSession(chat.taskRunId, "Through the cart service.");
      await reply(parseUuidV7(chat.conversationId), "Which file?");
      const continuationId = (await runsOf(chat.taskId))[1]?.id ?? "";

      const context = await h.workerContext(
        continuationId,
        await claim(continuationId),
      );

      expect(context.restoreSession).toBeNull();
      expect(context.agentPrompt.promptText).toContain("    Which file?");
    },
  );
});

const unwrapPin = async (
  promise: Promise<{ data: unknown; error: unknown }>,
) => {
  const result = await promise;
  if (result.error) {
    throw new Error(JSON.stringify(result.error));
  }
  return result.data;
};

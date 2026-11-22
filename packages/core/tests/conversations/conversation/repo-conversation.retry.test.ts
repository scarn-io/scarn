/**
 * DB-backed coverage for repo conversations (chats). In neither `unit/` (it
 * hits Postgres) nor `integration/` (they also read and seed
 * the database directly; route-level tests are in `integration/`).
 */
import { describe, expect } from "bun:test";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { serialTest } from "tests/utils";
import {
  createRepoConversationHarness,
  FAILURE,
} from "./repo-conversation-test-support";

describe("repo conversations: retrying", () => {
  const {
    h,
    created,
    claim,
    answer,
    fail,
    cancel,
    runsOf,
    reply,
    retry,
    conversationOf,
  } = createRepoConversationHarness();

  serialTest(
    "a failed chat is retryable: a fresh run, its turn still pending, and no system message",
    async () => {
      const chat = await created("Why is the build slow?");
      const conversationId = parseUuidV7(chat.conversationId);
      await fail(chat.taskRunId);

      const retried = await retry(chat.taskId, chat.taskRunId);
      expect(retried.status).toBe(200);
      const runs = await runsOf(chat.taskId);
      expect(runs.map(({ reason, status }) => ({ reason, status }))).toEqual([
        { reason: "initial", status: "failed" },
        { reason: "retry", status: "queued" },
      ]);
      expect(runs[1]?.sessionObjectKey ?? null).toBeNull();
      const conversation = await conversationOf(conversationId);
      expect(conversation.status).toBe("reply_pending");
      expect(conversation.messages.map((each) => each.authorKind)).toEqual([
        "person",
      ]);
    },
  );

  serialTest(
    "a failed later turn reopens the conversation for the agent with no system message",
    async () => {
      const chat = await created();
      const conversationId = parseUuidV7(chat.conversationId);
      await answer(chat.taskRunId, "First answer.");
      await reply(conversationId, "Follow-up?");
      const continuationId = (await runsOf(chat.taskId))[1]?.id ?? "";
      const claimToken = await claim(continuationId);
      await h.workerContext(continuationId, claimToken);
      await h.completeRun(continuationId, claimToken, {
        status: "failed",
        errorJson: FAILURE,
      });

      expect((await retry(chat.taskId, continuationId)).status).toBe(200);
      const conversation = await conversationOf(conversationId);
      expect(conversation.status).toBe("agent_turn");
      expect(
        conversation.messages.some((each) => each.authorKind === "system"),
      ).toBe(false);
    },
  );

  serialTest("a stale expectedLatestRunId gets 409", async () => {
    const chat = await created();
    await fail(chat.taskRunId);

    expect(await retry(chat.taskId, null)).toMatchObject({
      status: 409,
      code: "TASK_RETRY_STALE_RUN",
    });
    expect(await runsOf(chat.taskId)).toHaveLength(1);
  });

  serialTest("two concurrent retries produce one new run", async () => {
    const chat = await created();
    await fail(chat.taskRunId);

    const outcomes = await Promise.all([
      retry(chat.taskId, chat.taskRunId),
      retry(chat.taskId, chat.taskRunId),
    ]);
    expect(outcomes.map((each) => each.status).sort()).toEqual([200, 409]);
    expect(await runsOf(chat.taskId)).toHaveLength(2);
  });

  serialTest("the generic Task retry can't reopen an ended chat", async () => {
    const chat = await created();
    const conversationId = parseUuidV7(chat.conversationId);
    await cancel(chat.taskId);
    const before = await conversationOf(conversationId);
    expect(before.status).toBe("closed");

    expect(await retry(chat.taskId, chat.taskRunId)).toEqual({
      status: 409,
      code: "CONVERSATION_ENDED",
    });
    expect(await conversationOf(conversationId)).toEqual(before);
    expect(await runsOf(chat.taskId)).toHaveLength(1);
    expect((await h.loadTask(parseUuidV7(chat.taskId)))?.status).toBe(
      "cancelled",
    );
  });
});

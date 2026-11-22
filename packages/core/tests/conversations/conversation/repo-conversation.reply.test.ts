/**
 * DB-backed coverage for repo conversations (chats). In neither `unit/` (it
 * hits Postgres) nor `integration/` (they also read and seed
 * the database directly; route-level tests are in `integration/`).
 */
import { describe, expect } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { conversationMessages } from "@/lib/db/schema";
import { serialTest } from "tests/utils";
import { createRepoConversationHarness } from "./repo-conversation-test-support";

describe("repo conversations: replying", () => {
  const {
    h,
    created,
    claim,
    answer,
    fail,
    cancel,
    runsOf,
    reply,
    conversationOf,
  } = createRepoConversationHarness();

  serialTest(
    "replies sent before delivery go into one continuation, none lost or duplicated, and the agent then holds the floor",
    async () => {
      const chat = await created();
      const conversationId = parseUuidV7(chat.conversationId);
      await answer(chat.taskRunId, "It goes through the cart service.");

      expect(await reply(conversationId, "Which file?")).toMatchObject({
        status: 200,
      });
      expect(await reply(conversationId, "And the tests?")).toMatchObject({
        status: 200,
      });
      const runs = await runsOf(chat.taskId);
      expect(runs.map(({ reason, status }) => ({ reason, status }))).toEqual([
        { reason: "initial", status: "yielded" },
        { reason: "continuation", status: "queued" },
      ]);
      const continuationId = runs[1]?.id ?? "";

      const context = await h.workerContext(
        continuationId,
        await claim(continuationId),
      );
      expect(JSON.stringify(context)).toContain("Which file?");
      const delivered = await getDb()
        .select()
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.conversationId, conversationId),
            eq(conversationMessages.deliveredToTaskRunId, continuationId),
          ),
        )
        .orderBy(asc(conversationMessages.id));
      expect(delivered.map((each) => each.body)).toEqual([
        "Which file?",
        "And the tests?",
      ]);
      expect((await conversationOf(conversationId)).status).toBe("agent_turn");

      expect(await reply(conversationId, "Too late?")).toEqual({
        status: 409,
        code: "CONVERSATION_NOT_WAITING",
      });
      expect(await runsOf(chat.taskId)).toHaveLength(2);
    },
  );

  serialTest(
    "an ordinary answer yields and leaves the chat open for a reply",
    async () => {
      const chat = await created();
      const conversationId = parseUuidV7(chat.conversationId);

      await answer(chat.taskRunId, "It goes through the cart service.");

      expect((await runsOf(chat.taskId))[0]?.status).toBe("yielded");
      expect((await h.loadTask(parseUuidV7(chat.taskId)))?.status).toBe(
        "waiting_for_person",
      );
      const conversation = await conversationOf(conversationId);
      expect(conversation).toMatchObject({
        status: "waiting_for_person",
        closedAt: null,
      });
      expect(conversation.messages.map((each) => each.authorKind)).toEqual([
        "person",
        "agent",
      ]);
      expect((await reply(conversationId, "Which file?")).status).toBe(200);
    },
  );

  serialTest("a failed chat refuses replies and points to Retry", async () => {
    const chat = await created();
    const conversationId = parseUuidV7(chat.conversationId);
    await fail(chat.taskRunId);
    expect((await h.loadTask(parseUuidV7(chat.taskId)))?.status).toBe("failed");
    expect((await conversationOf(conversationId)).status).not.toBe("closed");

    expect(await reply(conversationId, "Hello?")).toEqual({
      status: 409,
      code: "CONVERSATION_TASK_FAILED",
    });
    expect((await conversationOf(conversationId)).messages).toHaveLength(1);
  });

  serialTest("an ended chat refuses replies", async () => {
    const chat = await created();
    const conversationId = parseUuidV7(chat.conversationId);
    await cancel(chat.taskId);
    expect((await conversationOf(conversationId)).status).toBe("closed");

    expect(await reply(conversationId, "Still there?")).toEqual({
      status: 409,
      code: "CONVERSATION_NOT_WAITING",
    });
  });
});

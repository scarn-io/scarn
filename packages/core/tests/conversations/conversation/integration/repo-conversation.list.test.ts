import { describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { ANONYMOUS_ACTOR_ID } from "@/access/authorization/anonymous-actor";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { serialTest, unwrapAsync } from "tests/utils";
import { createRepoConversationHarness } from "../repo-conversation-test-support";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

describe("GET /projects/:projectId/conversations", () => {
  const {
    h,
    created,
    claim,
    fail,
    end,
    pinBaseCommit,
    listAs,
    outsider,
    member,
  } = createRepoConversationHarness();
  const chatIds: UuidV7[] = [];

  const newChat = async (body?: string) => {
    const chat = await created(body);
    chatIds.unshift(chat.conversationId);
    return chat;
  };

  const page = async (query: Parameters<typeof listAs>[0] = {}) =>
    await unwrapAsync(listAs(query));

  serialTest(
    "lists only chats, never grilling conversations, newest first",
    async () => {
      await newChat("First question");
      const grilling = await h.handedOver("conversation");
      await newChat("Second question");
      await newChat("Third question");

      const listed = await page();

      expect(listed.conversations.map((each) => each.id)).toEqual(chatIds);
      expect(listed.conversations.map((each) => each.id)).not.toContain(
        grilling.conversationId,
      );
      expect(listed.nextCursor).toBeNull();
    },
  );

  serialTest(
    "each row has its preview, creator, state, last activity and short commit",
    async () => {
      const { ownerId } = h.requireSetup();
      const long = `How   does\ncheckout ${"work ".repeat(60)}`;
      const chat = await newChat(long);
      const claimToken = await claim(chat.taskRunId);
      await unwrapAsync(
        pinBaseCommit(chat.taskRunId, claimToken, COMMIT, "main"),
      );

      const [row] = (await page({ limit: 1 })).conversations;

      expect(Object.keys(row ?? {}).sort()).toEqual([
        "createdAt",
        "creator",
        "id",
        "lastActivityAt",
        "preview",
        "shortCommit",
        "state",
        "taskId",
      ]);
      expect(row).toMatchObject({
        id: chat.conversationId,
        taskId: chat.taskId,
        creator: { userId: ownerId, image: null },
        shortCommit: COMMIT.slice(0, 12),
      });
      expect(typeof row?.creator?.username).toBe("string");
      expect(row?.preview).toMatch(/^How does checkout work work .*…$/u);
      expect(row?.preview).toHaveLength(140);
      expect(Date.parse(row?.lastActivityAt ?? "")).toBeGreaterThanOrEqual(
        Date.parse(row?.createdAt ?? ""),
      );
    },
  );

  serialTest(
    "a row's state follows the chat, and an unpinned chat has no short commit",
    async () => {
      const failed = await newChat();
      await fail(failed.taskRunId);
      const ended = await newChat();
      await end(ended.conversationId);
      const queued = await newChat();

      const rows = new Map(
        (await page()).conversations.map((each) => [each.id, each]),
      );

      expect(rows.get(failed.conversationId)?.state).toBe("failed");
      expect(rows.get(ended.conversationId)?.state).toBe("ended");
      expect(rows.get(queued.conversationId)).toMatchObject({
        state: "queued",
        shortCommit: null,
      });
    },
  );

  serialTest(
    "pages through every chat once with the before cursor",
    async () => {
      const seen: string[] = [];
      let before: string | null | undefined;
      do {
        const next = await page({
          limit: 2,
          ...(before ? { before: parseUuidV7(before) } : {}),
        });
        expect(next.conversations.length).toBeLessThanOrEqual(2);
        seen.push(...next.conversations.map((each) => each.id));
        before = next.nextCursor;
      } while (before);

      expect(seen).toEqual(chatIds);
    },
  );

  serialTest("a page is stable when a newer chat is created", async () => {
    const first = await page({ limit: 2 });
    await newChat("Newer than the cursor");

    const second = await page({
      limit: 2,
      before: parseUuidV7(first.nextCursor ?? ""),
    });

    expect(second.conversations.map((each) => each.id)).toEqual(
      chatIds.slice(3, 5),
    );
  });

  serialTest("rejects a limit out of range", async () => {
    for (const limit of [0, 201]) {
      const { error } = await listAs({ limit });
      expect(error?.status).toBe(422);
    }
  });

  serialTest(
    "a private project: anonymous gets 401, an outsider 403, a reader may list",
    async () => {
      expect((await listAs({}, ANONYMOUS_ACTOR_ID)).error?.status).toBe(401);
      expect((await listAs({}, await outsider())).error?.status).toBe(403);
      const reader = await member("read");
      expect(
        (await unwrapAsync(listAs({}, reader))).conversations,
      ).toHaveLength(chatIds.length);
    },
  );

  serialTest(
    "an anonymous caller may list a public project's chats",
    async () => {
      await getDb()
        .update(projects)
        .set({ visibility: "public" })
        .where(eq(projects.id, h.requireSetup().projectId));

      const { data, error } = await listAs({}, ANONYMOUS_ACTOR_ID);

      expect(error).toBeNull();
      expect(data?.conversations.map((each) => each.id)).toEqual(chatIds);
    },
  );

  serialTest("an unknown project is 404", async () => {
    const { error } = await listAs(
      {},
      undefined,
      parseUuidV7("01900000-0000-7000-8000-000000000000"),
    );
    expect(error?.status).toBe(404);
  });
});

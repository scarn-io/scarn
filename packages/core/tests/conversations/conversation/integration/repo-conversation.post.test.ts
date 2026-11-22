import { describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { serialTest, unwrapAsync } from "tests/utils";
import { createRepoConversationHarness } from "../repo-conversation-test-support";

describe("POST /projects/:projectId/conversations", () => {
  const { h, created, member, headersFor } = createRepoConversationHarness();

  /** Posts `body` as is, including fields the contract refuses. */
  const post = async (
    body: Record<string, string | string[]>,
    actorId?: Parameters<typeof headersFor>[0],
  ) =>
    await h.apiClient.api
      .projects({ projectId: h.requireSetup().projectId })
      .conversations.post(body as { body: string }, headersFor(actorId));

  serialTest("returns 201 with the chat's detail", async () => {
    const { ownerId } = h.requireSetup();

    const response = await post({ body: "Where is auth handled?" });

    expect(response.status).toBe(201);
    expect(response.data).toMatchObject({
      workItemId: null,
      status: "reply_pending",
      messages: [{ authorKind: "person", body: "Where is auth handled?" }],
      creator: { userId: ownerId },
      context: { kind: "project_repo", commit: null },
      state: "queued",
      latestRun: { status: "queued", reason: "initial" },
      error: null,
      capabilities: {
        canReply: true,
        canRetry: true,
        canEnd: true,
        canDelete: true,
      },
    });
  });

  serialTest(
    "refuses a branch, commit, grants or work item with 422 naming the field",
    async () => {
      const extras: [string, string | string[]][] = [
        ["branch", "main"],
        ["commit", "a".repeat(40)],
        ["grants", []],
        ["workItemId", "01900000-0000-7000-8000-000000000000"],
      ];
      for (const [field, value] of extras) {
        const { error } = await post({ body: "Anything?", [field]: value });
        expect(error?.status).toBe(422);
        expect(JSON.stringify(error?.value)).toContain(field);
      }
    },
  );

  serialTest("refuses an empty question with 422", async () => {
    expect((await post({ body: "" })).error?.status).toBe(422);
    expect((await post({})).error?.status).toBe(422);
  });

  serialTest("returns 403 without executions:write", async () => {
    const reader = await member("read");
    const { error } = await post({ body: "Can I ask?" }, reader);
    expect(error?.status).toBe(403);
  });

  serialTest("returns 422 when the project has no repo", async () => {
    const { headers } = h.requireSetup();
    const repoless = await unwrapAsync(
      h.apiClient.api.projects.post(
        {
          name: `Repoless ${crypto.randomUUID()}`,
          description: "No repo",
          gitUrl: "https://github.com/example/repoless.git",
        },
        { headers },
      ),
    );
    await getDb()
      .update(projects)
      .set({ gitUrl: "" })
      .where(eq(projects.id, parseUuidV7(repoless.id)));

    const { error } = await h.apiClient.api
      .projects({ projectId: parseUuidV7(repoless.id) })
      .conversations.post({ body: "Anything?" }, { headers });

    expect(error?.status).toBe(422);
  });

  serialTest("a created chat can be read back", async () => {
    const chat = await created("Read me back");
    expect(chat.detail.messages.map((each) => each.body)).toEqual([
      "Read me back",
    ]);
  });
});

describe("POST /conversations/:conversationId/messages on a chat", () => {
  const { h, created, answer, claim, fail, end, reply, runsOf } =
    createRepoConversationHarness();

  serialTest("is 409 on a failed chat", async () => {
    const chat = await created();
    await fail(chat.taskRunId);

    expect(await reply(parseUuidV7(chat.conversationId), "Hello?")).toEqual({
      status: 409,
      code: "CONVERSATION_TASK_FAILED",
    });
  });

  serialTest("is 409 on an ended chat", async () => {
    const chat = await created();
    await end(chat.conversationId);

    expect(await reply(parseUuidV7(chat.conversationId), "Hello?")).toEqual({
      status: 409,
      code: "CONVERSATION_NOT_WAITING",
    });
  });

  serialTest("is 409 while the agent holds the floor", async () => {
    const chat = await created();
    await answer(chat.taskRunId, "An answer.");
    const conversationId = parseUuidV7(chat.conversationId);
    expect((await reply(conversationId, "Follow-up?")).status).toBe(200);
    const continuationId = (await runsOf(chat.taskId))[1]?.id ?? "";
    await h.workerContext(continuationId, await claim(continuationId));

    expect(await reply(conversationId, "Too late?")).toEqual({
      status: 409,
      code: "CONVERSATION_NOT_WAITING",
    });
  });

  serialTest("returns the chat with its state", async () => {
    const chat = await created();
    await answer(chat.taskRunId, "An answer.");

    const { data } = await h
      .conversationRoutes(parseUuidV7(chat.conversationId))
      .messages.post({ body: "Thanks" }, { headers: h.requireSetup().headers });

    expect(data).toMatchObject({
      state: "queued",
      latestRun: { reason: "continuation" },
    });
  });
});

describe("POST /conversations/:conversationId/retry", () => {
  const { h, created, fail, end, member, retryChat, runsOf } =
    createRepoConversationHarness();

  serialTest("retries a failed chat and returns it retry-queued", async () => {
    const chat = await created();
    await fail(chat.taskRunId);

    const retried = await unwrapAsync(
      retryChat(chat.conversationId, chat.taskRunId),
    );

    expect(retried).toMatchObject({
      state: "retry_queued",
      latestRun: { status: "queued", reason: "retry" },
    });
    expect(retried.latestRun?.id).not.toBe(chat.taskRunId);
  });

  serialTest("a stale expectedLatestRunId is 409", async () => {
    const chat = await created();
    await fail(chat.taskRunId);

    const { error } = await retryChat(chat.conversationId, null);

    expect(error?.status).toBe(409);
    expect(await runsOf(chat.taskId)).toHaveLength(1);
  });

  serialTest("two concurrent retries produce one new run", async () => {
    const chat = await created();
    await fail(chat.taskRunId);

    const outcomes = await Promise.all([
      retryChat(chat.conversationId, chat.taskRunId),
      retryChat(chat.conversationId, chat.taskRunId),
    ]);

    expect(outcomes.map((each) => each.error?.status ?? 200).sort()).toEqual([
      200, 409,
    ]);
    expect(await runsOf(chat.taskId)).toHaveLength(2);
  });

  serialTest("an ended chat is 409", async () => {
    const chat = await created();
    await fail(chat.taskRunId);
    await end(chat.conversationId);

    const { error } = await retryChat(chat.conversationId, chat.taskRunId);

    expect(error?.status).toBe(409);
    expect(error?.value).toMatchObject({ code: "CONVERSATION_ENDED" });
    expect(await runsOf(chat.taskId)).toHaveLength(1);
  });

  serialTest("needs executions:write", async () => {
    const chat = await created();
    await fail(chat.taskRunId);
    const reader = await member("read");

    const { error } = await retryChat(
      chat.conversationId,
      chat.taskRunId,
      reader,
    );

    expect(error?.status).toBe(403);
  });

  serialTest("a grilling conversation is 404", async () => {
    const grilling = await h.handedOver("conversation");

    const { error } = await retryChat(
      grilling.conversationId,
      grilling.taskRunId,
    );

    expect(error?.status).toBe(404);
  });
});

describe("POST /conversations/:conversationId/end", () => {
  const { created, end } = createRepoConversationHarness();

  serialTest("ends the chat, and ending it again does nothing", async () => {
    const chat = await created();

    const first = await end(chat.conversationId);
    const second = await end(chat.conversationId);

    expect(first.ok && first.value).toMatchObject({
      status: "closed",
      state: "ended",
    });
    expect(second.ok && second.value).toEqual(first.ok && first.value);
  });
});

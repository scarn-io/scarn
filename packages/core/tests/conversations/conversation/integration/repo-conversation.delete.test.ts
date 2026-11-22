import { describe, expect } from "bun:test";
import { serialTest } from "tests/utils";
import { createRepoConversationHarness } from "../repo-conversation-test-support";

describe("DELETE /conversations/:conversationId", () => {
  const { h, created, member, detailAs, headersFor } =
    createRepoConversationHarness();

  const deleteAs = async (
    conversationId: string,
    actorId?: Parameters<typeof headersFor>[0],
  ) =>
    await h.apiClient.api
      .conversations({ conversationId })
      .delete(undefined, headersFor(actorId));

  serialTest("returns 204, after which the chat is 404", async () => {
    const chat = await created();

    const response = await deleteAs(chat.conversationId);

    expect(response.status).toBe(204);
    expect(response.error).toBeNull();
    expect((await detailAs(chat.conversationId)).error?.status).toBe(404);
    expect((await deleteAs(chat.conversationId)).error?.status).toBe(404);
  });

  serialTest("is 403 to a reader who isn't the creator", async () => {
    const chat = await created();
    const reader = await member("read");

    expect((await deleteAs(chat.conversationId, reader)).error?.status).toBe(
      403,
    );
    expect((await detailAs(chat.conversationId)).error).toBeNull();
  });

  serialTest("a grilling conversation is 404", async () => {
    const grilling = await h.handedOver("conversation");

    expect((await deleteAs(grilling.conversationId)).error?.status).toBe(404);
  });
});

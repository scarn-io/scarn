/**
 * DB-backed coverage for repo conversations (chats). In neither `unit/` (it
 * hits Postgres) nor `integration/` (they also read and seed
 * the database directly; route-level tests are in `integration/`). Pinning a chat's commit through
 * `POST /task-runs/:id/base-commit`.
 */
import { describe, expect } from "bun:test";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { serialTest } from "tests/utils";
import {
  createRepoConversationHarness,
  FAILURE,
} from "./repo-conversation-test-support";

const FIRST = "a".repeat(40);
const SECOND = "b".repeat(64);

describe("repo conversations: pinning the base commit", () => {
  const { h, created, claim, pinBaseCommit, remove, runsOf, reply, retry } =
    createRepoConversationHarness();

  serialTest("needs the run's live claim", async () => {
    const chat = await created();
    await claim(chat.taskRunId);

    const result = await pinBaseCommit(chat.taskRunId, "not-the-claim", FIRST);

    expect(result.error?.status).toBe(409);
    expect((await runsOf(chat.taskId))[0]?.baseCommit).toBeNull();
  });

  serialTest("rejects anything but a full git object id", async () => {
    const chat = await created();
    const claimToken = await claim(chat.taskRunId);

    for (const baseCommit of ["abc123", "A".repeat(40), "g".repeat(40)]) {
      const result = await pinBaseCommit(
        chat.taskRunId,
        claimToken,
        baseCommit,
      );
      expect(result.error?.status).toBe(422);
    }
    expect((await runsOf(chat.taskId))[0]?.baseCommit).toBeNull();
  });

  serialTest(
    "sets the commit and branch once; a later report gets the stored values",
    async () => {
      const chat = await created();
      const claimToken = await claim(chat.taskRunId);

      const first = await pinBaseCommit(
        chat.taskRunId,
        claimToken,
        FIRST,
        "main",
      );
      const second = await pinBaseCommit(
        chat.taskRunId,
        claimToken,
        SECOND,
        "develop",
      );

      expect(first.data).toEqual({ baseCommit: FIRST, baseBranch: "main" });
      expect(second.data).toEqual({ baseCommit: FIRST, baseBranch: "main" });
      expect((await runsOf(chat.taskId))[0]).toMatchObject({
        baseCommit: FIRST,
        baseBranch: "main",
      });
    },
  );

  serialTest(
    "two concurrent reports leave one stored value and both get it back",
    async () => {
      const chat = await created();
      const claimToken = await claim(chat.taskRunId);

      const results = await Promise.all([
        pinBaseCommit(chat.taskRunId, claimToken, FIRST),
        pinBaseCommit(chat.taskRunId, claimToken, SECOND),
      ]);

      const stored = (await runsOf(chat.taskId))[0]?.baseCommit ?? "";
      expect([FIRST, SECOND]).toContain(stored);
      expect(results.map((each) => each.data?.baseCommit)).toEqual([
        stored,
        stored,
      ]);
    },
  );

  serialTest("is refused with 404 after the chat is deleted", async () => {
    const chat = await created();
    const claimToken = await claim(chat.taskRunId);
    expect((await remove(chat.conversationId)).ok).toBe(true);

    const result = await pinBaseCommit(chat.taskRunId, claimToken, FIRST);

    expect(result.error?.status).toBe(404);
  });

  serialTest(
    "a first turn that fails before pinning pins on its retry",
    async () => {
      const chat = await created();
      await h.completeRun(chat.taskRunId, await claim(chat.taskRunId), {
        status: "failed",
        errorJson: FAILURE,
      });
      expect((await retry(chat.taskId, chat.taskRunId)).status).toBe(200);
      const retryId = (await runsOf(chat.taskId))[1]?.id ?? "";
      const retryClaim = await claim(retryId);
      expect(
        (await h.workerContext(retryId, retryClaim)).baseCommit,
      ).toBeNull();

      const pinned = await pinBaseCommit(retryId, retryClaim, FIRST, "main");

      expect(pinned.data).toEqual({ baseCommit: FIRST, baseBranch: "main" });
      expect(
        (await runsOf(chat.taskId)).map(({ reason, baseCommit }) => ({
          reason,
          baseCommit,
        })),
      ).toEqual([
        { reason: "initial", baseCommit: null },
        { reason: "retry", baseCommit: FIRST },
      ]);
    },
  );

  serialTest(
    "the continuation and a retry copy the pinned commit and branch",
    async () => {
      const chat = await created();
      const claimToken = await claim(chat.taskRunId);
      await h.workerContext(chat.taskRunId, claimToken);
      await pinBaseCommit(chat.taskRunId, claimToken, FIRST, "main");
      await h.apiClient.api["task-runs"]({
        taskRunId: chat.taskRunId,
      }).yields.post(
        { claimToken, message: "It goes through the cart service." },
        { headers: h.requireSetup().headers },
      );
      await reply(parseUuidV7(chat.conversationId), "Which file?");
      const continuationId = (await runsOf(chat.taskId))[1]?.id ?? "";
      const continuationClaim = await claim(continuationId);
      const context = await h.workerContext(continuationId, continuationClaim);
      expect(context.baseCommit).toBe(FIRST);
      await h.completeRun(continuationId, continuationClaim, {
        status: "failed",
        errorJson: FAILURE,
      });

      expect((await retry(chat.taskId, continuationId)).status).toBe(200);

      expect(
        (await runsOf(chat.taskId)).map(
          ({ reason, baseCommit, baseBranch }) => ({
            reason,
            baseCommit,
            baseBranch,
          }),
        ),
      ).toEqual([
        { reason: "initial", baseCommit: FIRST, baseBranch: "main" },
        { reason: "continuation", baseCommit: FIRST, baseBranch: "main" },
        { reason: "retry", baseCommit: FIRST, baseBranch: "main" },
      ]);
    },
  );
});

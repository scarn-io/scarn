import { describe, expect } from "bun:test";
import { and, eq } from "drizzle-orm";
import { ANONYMOUS_ACTOR_ID } from "@/access/authorization/anonymous-actor";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { projectMemberships, projects } from "@/lib/db/schema";
import { serialTest, unwrapAsync } from "tests/utils";
import {
  createRepoConversationHarness,
  FAILURE,
} from "../repo-conversation-test-support";

const COMMIT = "fedcba9876543210fedcba9876543210fedcba98";
const REPOSITORY = "https://github.com/example/test-project.git";
const CHAT_FIELDS = [
  "taskId",
  "creator",
  "context",
  "state",
  "latestRun",
  "error",
  "capabilities",
];

describe("GET /conversations/:conversationId for a chat", () => {
  const {
    h,
    created,
    claim,
    answer,
    fail,
    end,
    retryChat,
    pinBaseCommit,
    detailAs,
  } = createRepoConversationHarness();

  const detail = async (conversationId: string) =>
    await unwrapAsync(detailAs(conversationId));

  serialTest(
    "the context has no commit before the pin, and the pinned one after",
    async () => {
      const chat = await created();

      expect((await detail(chat.conversationId)).context).toEqual({
        kind: "project_repo",
        repository: REPOSITORY,
        branch: null,
        commit: null,
        pinnedAt: null,
      });

      const claimToken = await claim(chat.taskRunId);
      await unwrapAsync(
        pinBaseCommit(chat.taskRunId, claimToken, COMMIT, "main"),
      );

      const pinned = await detail(chat.conversationId);
      expect(pinned.context).toMatchObject({
        kind: "project_repo",
        repository: REPOSITORY,
        branch: "main",
        commit: COMMIT,
      });
      expect(Number.isNaN(Date.parse(pinned.context?.pinnedAt ?? ""))).toBe(
        false,
      );
    },
  );

  serialTest(
    "the state follows the chat: queued, waiting, failed, retry queued and ended",
    async () => {
      const queued = await created();
      expect(await detail(queued.conversationId)).toMatchObject({
        state: "queued",
        latestRun: {
          id: queued.taskRunId,
          status: "queued",
          reason: "initial",
        },
        error: null,
      });

      const waiting = await created();
      await answer(waiting.taskRunId, "Here is the answer.");
      expect((await detail(waiting.conversationId)).state).toBe("waiting");

      const failed = await created();
      await fail(failed.taskRunId);
      expect((await detail(failed.conversationId)).state).toBe("failed");

      await unwrapAsync(retryChat(failed.conversationId, failed.taskRunId));
      expect(await detail(failed.conversationId)).toMatchObject({
        state: "retry_queued",
        latestRun: { status: "queued", reason: "retry" },
        error: null,
      });

      await end(failed.conversationId);
      expect(await detail(failed.conversationId)).toMatchObject({
        status: "closed",
        state: "ended",
      });
    },
  );

  serialTest(
    "a failed turn shows a safe error, never the run's own message",
    async () => {
      const chat = await created();
      await fail(chat.taskRunId);

      const failed = await detail(chat.conversationId);

      expect(failed.error).toEqual({
        code: "Scarn.StepFailed",
        message: "The turn failed",
      });
      expect(JSON.stringify(failed)).not.toContain(FAILURE.message);
    },
  );

  serialTest("a missing pinned commit has its fixed message", async () => {
    const chat = await created();
    const claimToken = await claim(chat.taskRunId);
    await h.completeRun(chat.taskRunId, claimToken, {
      status: "failed",
      errorJson: {
        name: "Error",
        code: "REPO_CONTEXT_COMMIT_UNAVAILABLE",
        message: "fatal: reference is not a tree: /home/worker/secret",
      },
    });

    const failed = await detail(chat.conversationId);

    expect(failed.error).toEqual({
      code: "REPO_CONTEXT_COMMIT_UNAVAILABLE",
      message: "The pinned commit is no longer available",
    });
    expect(JSON.stringify(failed)).not.toContain("/home/worker/secret");
  });

  serialTest("a grilling conversation keeps its shape", async () => {
    const grilling = await h.handedOver("conversation");

    const conversation = await detail(grilling.conversationId);

    expect(conversation.workItemId).toBe(grilling.workItemId);
    for (const field of CHAT_FIELDS) {
      expect(Object.keys(conversation)).not.toContain(field);
    }
  });

  serialTest("an unknown conversation is 404", async () => {
    const { error } = await detailAs("01900000-0000-7000-8000-000000000000");
    expect(error?.status).toBe(404);
  });
});

describe("GET /conversations/:conversationId capabilities", () => {
  const { h, created, member, outsider, detailAs } =
    createRepoConversationHarness();

  const NONE = {
    canReply: false,
    canRetry: false,
    canEnd: false,
    canDelete: false,
  };

  serialTest(
    "a private project's chat is 401 anonymous and 403 to an outsider",
    async () => {
      const chat = await created();

      expect(
        (await detailAs(chat.conversationId, ANONYMOUS_ACTOR_ID)).error?.status,
      ).toBe(401);
      expect(
        (await detailAs(chat.conversationId, await outsider())).error?.status,
      ).toBe(403);
    },
  );

  serialTest(
    "each viewer of a public project's chat gets what they may do",
    async () => {
      const creator = await member("write");
      const chat = await created(undefined, creator);
      const reader = await member("read");
      const stranger = await outsider();
      await getDb()
        .update(projects)
        .set({ visibility: "public" })
        .where(eq(projects.id, h.requireSetup().projectId));

      const capabilitiesOf = async (actorId?: Parameters<typeof detailAs>[1]) =>
        (await unwrapAsync(detailAs(chat.conversationId, actorId)))
          .capabilities;

      expect(await capabilitiesOf(ANONYMOUS_ACTOR_ID)).toEqual(NONE);
      expect(await capabilitiesOf(stranger)).toEqual(NONE);
      expect(await capabilitiesOf(reader)).toEqual(NONE);
      expect(await capabilitiesOf(creator)).toEqual({
        canReply: true,
        canRetry: true,
        canEnd: true,
        canDelete: true,
      });
      expect(await capabilitiesOf()).toEqual({
        canReply: true,
        canRetry: true,
        canEnd: true,
        canDelete: true,
      });

      await getDb()
        .delete(projectMemberships)
        .where(
          and(
            eq(projectMemberships.projectId, h.requireSetup().projectId),
            eq(projectMemberships.userId, creator),
          ),
        );
      expect(await capabilitiesOf(creator)).toEqual(NONE);
      expect(
        (await unwrapAsync(detailAs(chat.conversationId, creator))).creator
          ?.userId,
      ).toBe(parseUuidV7(creator));
    },
  );
});

import { describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { conversations, taskRuns } from "@/lib/db/schema";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  continueTask,
  replyToTask,
  type ActedOnTask,
  type ActOnTaskDeps,
} from "@/tasks/task/application/reply-to-task";
import type { DbExecutor } from "@/lib/db/db-executor";
import type { ResourceNotFoundError } from "@/lib/errors";
import type { Result } from "@/lib/result";
import { noopTaskOutcomePort } from "@/tasks/task/application/task-outcome-port";
import type { WorkNotifier } from "@/tasks/task-run/application/work-notifier";
import { recordingWorkNotifier } from "tests/tasks/task-run/recording-work-notifier";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { createHandOverHarness } from "./hand-over-test-support";

/**
 * Replies go to the Task: a reply, or continuing without one, queues a
 * standalone Task's `continuation` run on the yielded run's work branch;
 * Done ends a Task with no result schema.
 */
describe("replying to a Task", () => {
  const {
    appContext,
    requireSetup,
    loadTask,
    messagesOf,
    handedOver,
    conversationRoutes,
  } = createHandOverHarness();

  const actAsOwner = async <I>(
    action: (
      input: I,
      deps: ActOnTaskDeps,
      tx: DbExecutor,
    ) => Promise<Result<ActedOnTask, ResourceNotFoundError>>,
    input: I,
    workNotifier: WorkNotifier = appContext.workNotifier,
  ) => {
    const userAuthz = appContext.createUserAuthorizationService(
      requireSetup().ownerId,
    );
    return await getDb().transaction((tx) =>
      action(
        input,
        {
          ...appContext,
          userAuthz,
          taskOutcomePort: noopTaskOutcomePort,
          workNotifier,
        },
        tx,
      ),
    );
  };

  const runsOf = async (taskId: UuidV7) =>
    (
      await getDb().select().from(taskRuns).where(eq(taskRuns.taskId, taskId))
    ).sort((left, right) => left.number - right.number);

  const conversationOf = async (conversationId: UuidV7) =>
    (
      await getDb()
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId))
    )[0];

  concurrentTest(
    "a reply posts the message and queues a continuation on the yielded work branch",
    async () => {
      const { taskId, conversationId } = await handedOver();

      await actAsOwner(replyToTask, { conversationId, body: "v2, please." });

      expect((await loadTask(taskId))?.status).toBe("queued");
      expect(await runsOf(taskId)).toMatchObject([
        { number: 1, status: "yielded" },
        {
          number: 2,
          reason: "continuation",
          status: "queued",
          baseBranch: "scarn/hand-over-1",
        },
      ]);
      expect(
        (await messagesOf(conversationId)).map((each) => [
          each.authorKind,
          each.body,
        ]),
      ).toEqual([
        ["agent", "v1 or v2?"],
        ["person", "v2, please."],
      ]);
      expect((await conversationOf(conversationId))?.status).toBe(
        "reply_pending",
      );
    },
  );

  concurrentTest(
    "a reply that queues a continuation tells the notifier the Task's project",
    async () => {
      const { conversationId } = await handedOver();
      const { workNotifier, enqueued } = recordingWorkNotifier();

      await actAsOwner(
        replyToTask,
        { conversationId, body: "v2, please." },
        workNotifier,
      );

      expect(enqueued).toEqual([requireSetup().projectId]);
    },
  );

  concurrentTest(
    "a second reply joins the pending turn without another run",
    async () => {
      const { taskId, conversationId } = await handedOver();
      const reply = (body: string) =>
        unwrapAsync(
          conversationRoutes(conversationId).messages.post(
            { body },
            { headers: requireSetup().headers },
          ),
        );

      await reply("v2.");
      const second = await reply("And keep v1 working.");

      expect(second.status).toBe("reply_pending");
      expect(await runsOf(taskId)).toHaveLength(2);
    },
  );

  concurrentTest(
    "continuing without a reply posts a system message and queues the continuation",
    async () => {
      const { taskId, conversationId } = await handedOver();

      await actAsOwner(continueTask, { conversationId });

      expect((await loadTask(taskId))?.status).toBe("queued");
      expect((await runsOf(taskId)).at(-1)).toMatchObject({
        reason: "continuation",
        baseBranch: "scarn/hand-over-1",
      });
      expect((await messagesOf(conversationId)).at(-1)).toMatchObject({
        authorKind: "system",
        body: expect.stringMatching(
          /^.+ chose to continue without a reply$/,
        ) as string,
      });
    },
  );

  concurrentTest(
    "Done succeeds a Task with no result schema with { conversationId, summary }",
    async () => {
      const { taskId, conversationId } = await handedOver(
        "conversation",
        "Plan: ship v2 behind a flag.",
      );

      const ended = await unwrapAsync(
        conversationRoutes(conversationId).done.post(undefined, {
          headers: requireSetup().headers,
        }),
      );

      expect(ended.messages.at(-1)).toMatchObject({
        authorKind: "system",
        body: expect.stringMatching(/^.+ ended the conversation$/) as string,
      });
      expect(await loadTask(taskId)).toMatchObject({
        status: "succeeded",
        resultJson: { conversationId, summary: "Plan: ship v2 behind a flag." },
      });
      expect(await runsOf(taskId)).toHaveLength(1);
    },
  );

  concurrentTest("Done is refused on a Task with a result schema", async () => {
    const { taskId, conversationId } = await handedOver();

    const refused = await conversationRoutes(conversationId).done.post(
      undefined,
      { headers: requireSetup().headers },
    );

    expect(refused.status).toBe(422);
    expect(refused.error?.value).toMatchObject({
      code: "CONVERSATION_STEP_HAS_RESULT_SCHEMA",
    });
    expect((await loadTask(taskId))?.status).toBe("waiting_for_person");
    expect(
      (await messagesOf(conversationId)).map((each) => each.authorKind),
    ).toEqual(["agent"]);
  });

  concurrentTest("acting on a Task that isn't waiting is refused", async () => {
    const { taskId, conversationId } = await handedOver("conversation");
    await actAsOwner(continueTask, { conversationId });

    for (const response of [
      await conversationRoutes(conversationId).continue.post(undefined, {
        headers: requireSetup().headers,
      }),
      await conversationRoutes(conversationId).done.post(undefined, {
        headers: requireSetup().headers,
      }),
    ]) {
      expect(response.status).toBe(409);
      expect(response.error?.value).toMatchObject({
        code: "CONVERSATION_NOT_WAITING",
      });
    }
    expect(await runsOf(taskId)).toHaveLength(2);
  });

  concurrentTest(
    "a person without access to the project can't reply",
    async () => {
      const { taskId, conversationId } = await handedOver();
      const stranger = await createTestUserAndSession({
        email: `stranger-${crypto.randomUUID()}@example.com`,
      });

      const refused = await conversationRoutes(conversationId).messages.post(
        { body: "Hi" },
        { headers: stranger.authHeaders },
      );

      expect(refused.status).toBe(403);
      expect((await loadTask(taskId))?.status).toBe("waiting_for_person");
    },
  );
});

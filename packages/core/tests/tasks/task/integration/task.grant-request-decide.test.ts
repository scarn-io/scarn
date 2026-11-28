import { describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { conversations, taskGrantRequests, taskRuns } from "@/lib/db/schema";
import { CoreError } from "@/lib/errors";
import { decideGrantRequest } from "@/tasks/task/application/decide-grant-request";
import { noopTaskOutcomePort } from "@/tasks/task/application/task-outcome-port";
import type { Grant } from "@/tasks/task/domain/grants";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { grant } from "tests/tasks/task/grants-test-support";
import { createHandOverHarness } from "./hand-over-test-support";

const held: Grant[] = [grant("read", "self"), grant("label", "self", ["a"])];

const requestsOf = async (taskId: UuidV7) =>
  await getDb()
    .select()
    .from(taskGrantRequests)
    .where(eq(taskGrantRequests.taskId, taskId));

const runsOf = async (taskId: UuidV7) =>
  (
    await getDb().select().from(taskRuns).where(eq(taskRuns.taskId, taskId))
  ).sort((left, right) => left.number - right.number);

const conversationStatus = async (conversationId: UuidV7) =>
  (
    await getDb()
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
  )[0]?.status;

/**
 * A person decides a Task's pending grant request: the approved grants join
 * the Task's, a linked `system` message says what was decided, and the Task
 * resumes. A reply or Continue closes it `unanswered`; cancelling the Task
 * closes it `withdrawn`.
 */
describe("deciding a grant request", () => {
  const {
    appContext,
    apiClient,
    requireSetup,
    seedItem,
    startTask,
    yieldRun,
    loadTask,
    messagesOf,
    conversationRoutes,
  } = createHandOverHarness({
    objectStore: null,
    grants: held,
    grantRequests: true,
  });

  /** A Task waiting on a pending request for `grants`. */
  const requested = async (grants: Grant[]) => {
    const workItemId = await seedItem();
    const { taskId, taskRunId } = await startTask(workItemId, "conversation");
    await yieldRun(workItemId, taskRunId, {
      message: "I need more access.",
      workBranch: "scarn/grants-1",
      grantRequest: { reason: "To finish the job", grants },
    });
    const [request] = await requestsOf(taskId);
    const conversationId = (await loadTask(taskId))?.conversationId;
    if (!request || !conversationId) {
      throw new Error("Expected a pending request and a conversation");
    }
    return {
      taskId,
      requestId: request.id as UuidV7,
      conversationId: conversationId as UuidV7,
    };
  };

  const decide = (
    grantRequestId: UuidV7,
    body: { approved: Grant[]; note?: string },
  ) =>
    apiClient.api["task-grant-requests"]({ grantRequestId }).decision.post(
      body,
      { headers: requireSetup().headers },
    );

  const expectResumed = async (taskId: UuidV7, conversationId: UuidV7) => {
    expect((await loadTask(taskId))?.status).toBe("queued");
    expect(await runsOf(taskId)).toMatchObject([
      { number: 1, status: "yielded" },
      {
        number: 2,
        reason: "continuation",
        status: "queued",
        baseBranch: "scarn/grants-1",
      },
    ]);
    expect(await conversationStatus(conversationId)).toBe("reply_pending");
  };

  concurrentTest(
    "approving all adds the grants, posts a linked message and resumes the Task",
    async () => {
      const { taskId, requestId, conversationId } = await requested([
        grant("close", "self"),
        grant("comment", "self"),
      ]);

      const conversation = await unwrapAsync(
        decide(requestId, {
          approved: [grant("close", "self"), grant("comment", "self")],
          note: "Go ahead.",
        }),
      );

      expect(conversation.id).toBe(conversationId);
      const [request] = await requestsOf(taskId);
      expect(request).toMatchObject({
        status: "decided",
        approvedJson: [grant("close", "self"), grant("comment", "self")],
        note: "Go ahead.",
        decidedByUserId: requireSetup().ownerId,
      });
      expect(request?.decidedAt).not.toBeNull();
      expect((await loadTask(taskId))?.grants).toEqual([
        ...held,
        grant("close", "self"),
        grant("comment", "self"),
      ]);
      const last = (await messagesOf(conversationId)).at(-1);
      expect(last).toMatchObject({
        authorKind: "system",
        grantRequestId: requestId,
      });
      expect(last?.body).toEndWith("approved all 2 requested grants");
      await expectResumed(taskId, conversationId);
    },
  );

  concurrentTest(
    "approving some labels counts the grant and merges the labels",
    async () => {
      const { taskId, requestId, conversationId } = await requested([
        grant("label", "self", ["b", "c"]),
        grant("close", "self"),
      ]);

      await unwrapAsync(
        decide(requestId, { approved: [grant("label", "self", ["b"])] }),
      );

      expect((await loadTask(taskId))?.grants).toEqual([
        grant("read", "self"),
        grant("label", "self", ["a", "b"]),
      ]);
      expect((await messagesOf(conversationId)).at(-1)?.body).toEndWith(
        "approved 1 of 2 requested grants",
      );
      await expectResumed(taskId, conversationId);
    },
  );

  concurrentTest(
    "denying keeps the Task's grants and still resumes it",
    async () => {
      const { taskId, requestId, conversationId } = await requested([
        grant("close", "self"),
      ]);

      await unwrapAsync(decide(requestId, { approved: [] }));

      const [request] = await requestsOf(taskId);
      expect(request).toMatchObject({
        status: "decided",
        approvedJson: [],
        note: null,
      });
      expect((await loadTask(taskId))?.grants).toEqual(held);
      const last = (await messagesOf(conversationId)).at(-1);
      expect(last).toMatchObject({
        authorKind: "system",
        grantRequestId: requestId,
      });
      expect(last?.body).toEndWith("denied the request");
      await expectResumed(taskId, conversationId);
    },
  );

  concurrentTest("a second decision is refused with 409", async () => {
    const { taskId, requestId } = await requested([grant("close", "self")]);
    await unwrapAsync(decide(requestId, { approved: [] }));

    const again = await decide(requestId, {
      approved: [grant("close", "self")],
    });

    expect(again.error?.status).toBe(409);
    expect(again.error?.value).toMatchObject({
      code: "GRANT_REQUEST_NOT_PENDING",
    });
    expect((await loadTask(taskId))?.grants).toEqual(held);
    expect(await runsOf(taskId)).toHaveLength(2);
  });

  concurrentTest(
    "an approval the request doesn't cover is refused with 422",
    async () => {
      const { taskId, requestId } = await requested([
        grant("label", "self", ["b"]),
      ]);

      for (const approved of [
        [grant("close", "self")],
        [grant("label", "self", ["z"])],
        [grant("label", "children", ["b"])],
      ]) {
        const refused = await decide(requestId, { approved });
        expect(refused.error?.status).toBe(422);
        expect(refused.error?.value).toMatchObject({
          code: "GRANT_REQUEST_APPROVAL_INVALID",
        });
      }
      expect((await requestsOf(taskId))[0]?.status).toBe("pending");
      expect((await loadTask(taskId))?.status).toBe("waiting_for_person");
    },
  );

  /** Decides as the owner without `work-items:write`. */
  const decideWithoutWorkItemsWrite = async (
    grantRequestId: UuidV7,
    approved: Grant[],
  ) => {
    const owner = appContext.createUserAuthorizationService(
      requireSetup().ownerId,
    );
    const userAuthz: typeof owner = {
      actorId: owner.actorId,
      requireProjectMember: (...args) => owner.requireProjectMember(...args),
      requireProjectPermission: (input) => {
        if (input.permission === "work-items:write") {
          throw new CoreError({
            code: "FORBIDDEN",
            message: "No work-items:write",
            status: 403,
          });
        }
        return owner.requireProjectPermission(input);
      },
    };
    return await getDb().transaction((tx) =>
      decideGrantRequest(
        { grantRequestId, approved },
        { ...appContext, userAuthz, taskOutcomePort: noopTaskOutcomePort },
        tx,
      ),
    );
  };

  concurrentTest(
    "approving a grant that changes work items needs work-items:write",
    async () => {
      const { taskId, requestId } = await requested([grant("close", "self")]);

      let status: number | null = null;
      try {
        await decideWithoutWorkItemsWrite(requestId, [grant("close", "self")]);
      } catch (error) {
        status = error instanceof CoreError ? error.status : null;
      }

      expect(status).toBe(403);
      expect((await requestsOf(taskId))[0]?.status).toBe("pending");
    },
  );

  concurrentTest(
    "approving only read grants needs only executions:write",
    async () => {
      const { taskId, requestId } = await requested([
        grant("read", "children"),
      ]);

      const decided = await decideWithoutWorkItemsWrite(requestId, [
        grant("read", "children"),
      ]);

      expect(decided.ok).toBe(true);
      expect((await loadTask(taskId))?.grants).toContainEqual(
        grant("read", "children"),
      );
    },
  );

  concurrentTest("a reply closes the request unanswered", async () => {
    const { taskId, conversationId } = await requested([
      grant("close", "self"),
    ]);

    await unwrapAsync(
      conversationRoutes(conversationId).messages.post(
        { body: "Not now." },
        { headers: requireSetup().headers },
      ),
    );

    expect((await requestsOf(taskId))[0]).toMatchObject({
      status: "unanswered",
      approvedJson: null,
    });
    expect((await loadTask(taskId))?.grants).toEqual(held);
    await expectResumed(taskId, conversationId);
  });

  concurrentTest("continuing closes the request unanswered", async () => {
    const { taskId, conversationId } = await requested([
      grant("close", "self"),
    ]);

    await unwrapAsync(
      conversationRoutes(conversationId).continue.post(undefined, {
        headers: requireSetup().headers,
      }),
    );

    expect((await requestsOf(taskId))[0]?.status).toBe("unanswered");
    await expectResumed(taskId, conversationId);
  });

  concurrentTest("cancelling the Task withdraws the request", async () => {
    const { taskId, requestId } = await requested([grant("close", "self")]);

    await unwrapAsync(
      apiClient.api.tasks({ taskId }).cancel.post(undefined, {
        headers: requireSetup().headers,
      }),
    );

    expect((await requestsOf(taskId))[0]?.status).toBe("withdrawn");
    const late = await decide(requestId, { approved: [] });
    expect(late.error?.status).toBe(409);
  });

  concurrentTest("GET lists the Task's requests, oldest first", async () => {
    const { taskId, requestId } = await requested([
      grant("label", "self", ["b"]),
    ]);
    await unwrapAsync(
      decide(requestId, {
        approved: [grant("label", "self", ["b"])],
        note: "ok",
      }),
    );

    const listed = await unwrapAsync(
      apiClient.api
        .tasks({ taskId })
        ["grant-requests"].get({ headers: requireSetup().headers }),
    );

    expect(listed).toEqual([
      {
        id: requestId,
        taskId,
        taskRunId: expect.any(String) as UuidV7,
        reason: "To finish the job",
        requested: [grant("label", "self", ["b"])],
        status: "decided",
        approved: [grant("label", "self", ["b"])],
        note: "ok",
        decidedByUserId: requireSetup().ownerId,
        decidedAt: expect.any(String) as string,
        createdAt: expect.any(String) as string,
      },
    ]);
  });
});

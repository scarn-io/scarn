import { describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  taskGrantRequests,
  taskRuns,
  userNotifications,
} from "@/lib/db/schema";
import type { Grant } from "@/tasks/task/domain/grants";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { concurrentTest } from "tests/utils";
import { grant } from "tests/tasks/task/grants-test-support";
import { createHandOverHarness } from "./hand-over-test-support";

const held: Grant[] = [
  grant("read", "self"),
  grant("comment", "self"),
  grant("label", "self", ["a"]),
];

const requestsOf = async (taskId: UuidV7) =>
  await getDb()
    .select()
    .from(taskGrantRequests)
    .where(eq(taskGrantRequests.taskId, taskId));

const notificationsOf = async (taskId: UuidV7) =>
  await getDb()
    .select()
    .from(userNotifications)
    .where(eq(userNotifications.taskId, taskId));

const runOf = async (taskRunId: string) =>
  (
    await getDb()
      .select()
      .from(taskRuns)
      .where(eq(taskRuns.id, taskRunId as UuidV7))
  )[0];

/**
 * An agent that hands over asking for more grants: the request is recorded
 * `pending` with the hand-over, linked from the agent's message, and named
 * in the notification. Grants the Task already holds are dropped.
 */
describe("a grant request on a yield", () => {
  const {
    apiClient,
    requireSetup,
    seedItem,
    claim,
    startTask,
    yieldRun,
    loadTask,
    messagesOf,
  } = createHandOverHarness({
    objectStore: null,
    grants: held,
    grantRequests: true,
  });

  const started = async () => {
    const workItemId = await seedItem({
      assigneeUserId: requireSetup().ownerId,
    });
    const { taskId, taskRunId } = await startTask(workItemId, "conversation");
    return { workItemId, taskId, taskRunId };
  };

  const conversationOf = async (taskId: UuidV7) => {
    const conversationId = (await loadTask(taskId))?.conversationId;
    if (!conversationId) {
      throw new Error("Expected the Task's conversation");
    }
    return conversationId;
  };

  concurrentTest(
    "is stored pending, linked from the agent's message and named in the notification",
    async () => {
      const { workItemId, taskId, taskRunId } = await started();
      const yielded = await yieldRun(workItemId, taskRunId, {
        message: "I need to close this item.",
        grantRequest: {
          reason: "Closing the item finishes the job",
          grants: [grant("close", "self")],
        },
      });

      expect(yielded.status).toBe("yielded");
      expect((await loadTask(taskId))?.status).toBe("waiting_for_person");
      const [request] = await requestsOf(taskId);
      expect(request).toMatchObject({
        status: "pending",
        reason: "Closing the item finishes the job",
        taskRunId,
        requestedJson: [grant("close", "self")],
      });
      const messages = await messagesOf(await conversationOf(taskId));
      expect(messages.at(-1)).toMatchObject({
        authorKind: "agent",
        body: "I need to close this item.",
        grantRequestId: request?.id,
      });
      const notifications = await notificationsOf(taskId);
      expect(notifications.length).toBeGreaterThan(0);
      for (const notification of notifications) {
        expect(notification.payloadJson).toMatchObject({
          grantRequestId: request?.id,
        });
      }
    },
  );

  concurrentTest("an empty final message posts the reason", async () => {
    const { workItemId, taskId, taskRunId } = await started();
    await yieldRun(workItemId, taskRunId, {
      message: "",
      grantRequest: {
        reason: "I need to block this item",
        grants: [grant("block", "self")],
      },
    });

    const [request] = await requestsOf(taskId);
    const messages = await messagesOf(await conversationOf(taskId));
    expect(messages.at(-1)).toMatchObject({
      body: "I need to block this item",
      grantRequestId: request?.id,
    });
  });

  concurrentTest(
    "drops held grants and narrows labels to the ones not held",
    async () => {
      const { workItemId, taskId, taskRunId } = await started();
      await yieldRun(workItemId, taskRunId, {
        message: "More please.",
        grantRequest: {
          reason: "To finish",
          grants: [
            grant("comment", "self"),
            grant("label", "self", ["a", "b"]),
            grant("close", "self"),
          ],
        },
      });

      const [request] = await requestsOf(taskId);
      expect(request?.requestedJson).toEqual([
        grant("label", "self", ["b"]),
        grant("close", "self"),
      ]);
    },
  );

  concurrentTest(
    "asking only for held grants is a plain hand-over",
    async () => {
      const { workItemId, taskId, taskRunId } = await started();
      await yieldRun(workItemId, taskRunId, {
        message: "Over to you.",
        grantRequest: {
          reason: "Already have these",
          grants: [grant("comment", "self"), grant("label", "self", ["a"])],
        },
      });

      expect((await loadTask(taskId))?.status).toBe("waiting_for_person");
      expect(await requestsOf(taskId)).toEqual([]);
      const messages = await messagesOf(await conversationOf(taskId));
      expect(messages.at(-1)).toMatchObject({
        body: "Over to you.",
        grantRequestId: null,
      });
      for (const notification of await notificationsOf(taskId)) {
        expect(notification.payloadJson).not.toHaveProperty("grantRequestId");
      }
    },
  );

  concurrentTest(
    "a yield failed by refused work item changes records no request",
    async () => {
      const { workItemId, taskId, taskRunId } = await started();
      const other = await seedItem();
      const yielded = await yieldRun(workItemId, taskRunId, {
        message: "Done for now.",
        workItemChanges: [
          { kind: "comment", workItemId: other, body: "Not mine" },
        ],
        grantRequest: {
          reason: "To finish",
          grants: [grant("close", "self")],
        },
      });

      expect(yielded.status).toBe("failed");
      expect(await requestsOf(taskId)).toEqual([]);
    },
  );

  concurrentTest(
    "a grant an agent may not hold is refused with 422 and the run keeps running",
    async () => {
      const { workItemId, taskId, taskRunId } = await started();
      const claimToken = await claim(workItemId, taskRunId);
      const response = await apiClient.api["task-runs"]({
        taskRunId,
      }).yields.post(
        {
          claimToken,
          message: "Let me edit everything.",
          grantRequest: {
            reason: "Wider edits",
            grants: [grant("update", "project")],
          },
        },
        { headers: requireSetup().headers },
      );

      expect(response.error?.status).toBe(422);
      expect(response.error?.value).toMatchObject({
        code: "GRANT_REQUEST_NOT_ALLOWED",
      });
      expect((await runOf(taskRunId))?.status).toBe("running");
      expect(await requestsOf(taskId)).toEqual([]);
    },
  );
});

describe("a grant request from a Task that may not make one", () => {
  const { apiClient, requireSetup, seedItem, claim, startTask, loadTask } =
    createHandOverHarness({ objectStore: null, grants: held });

  concurrentTest("is refused with 422 before anything changes", async () => {
    const workItemId = await seedItem();
    const { taskId, taskRunId } = await startTask(workItemId, "conversation");
    const claimToken = await claim(workItemId, taskRunId);
    const response = await apiClient.api["task-runs"]({
      taskRunId,
    }).yields.post(
      {
        claimToken,
        message: "May I close it?",
        grantRequest: {
          reason: "Closing finishes the job",
          grants: [grant("close", "self")],
        },
      },
      { headers: requireSetup().headers },
    );

    expect(response.error?.status).toBe(422);
    expect(response.error?.value).toMatchObject({
      code: "GRANT_REQUEST_NOT_ALLOWED",
    });
    expect((await runOf(taskRunId))?.status).toBe("running");
    expect((await loadTask(taskId))?.status).not.toBe("waiting_for_person");
    expect(await requestsOf(taskId)).toEqual([]);
  });
});

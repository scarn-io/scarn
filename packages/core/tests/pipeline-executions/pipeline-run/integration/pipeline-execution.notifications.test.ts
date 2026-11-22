import { beforeAll, describe, expect } from "bun:test";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { createPipelineFromDocument } from "tests/pipeline-definitions/pipeline-test-support";
import { createTestWorkItem } from "tests/tasks/task-run/integration/task-run-test-support";
import { serialTest, unwrapAsync } from "tests/utils";
import { createConversationHarness } from "./conversation-test-support";

const createNotificationHarness = (name: string) => {
  const conversationHarness = createConversationHarness(name);
  const { harness, headers } = conversationHarness;

  const listNotifications = async (workItemId: UuidV7) =>
    await unwrapAsync(
      harness.apiClient.api
        .projects({ projectId: harness.requireSetup().projectId })
        .notifications.get({ query: { workItemId }, headers: headers() }),
    );

  const getNotification = async (notificationId: UuidV7) =>
    await unwrapAsync(
      harness.apiClient.api
        .projects({ projectId: harness.requireSetup().projectId })
        .notifications({ notificationId })
        .get({ headers: headers() }),
    );

  return { ...conversationHarness, listNotifications, getNotification };
};

describe("pipeline execution notifications: telling people Scarn waits on them", () => {
  const {
    harness,
    headers,
    setUp,
    documentFor,
    yieldTask,
    reply,
    startHandedOverRun,
    startWaitingRun,
    listNotifications,
    getNotification,
  } = createNotificationHarness("pipeline-run-notifications");

  beforeAll(async () => {
    await setUp();
  });

  serialTest(
    "each hand-off notifies the work item's creator about the conversation",
    async () => {
      const { executionId, workItemId, claimed, conversationId } =
        await startHandedOverRun();
      const { projectId, userId } = harness.requireSetup();
      const claimedRun = await harness.getTaskRun(claimed.taskId);

      const [handOff, ...rest] = await listNotifications(workItemId);
      expect(rest).toEqual([]);
      expect(handOff).toMatchObject({
        projectId,
        workItemId,
        pipelineExecutionId: executionId,
        taskId: claimedRun.taskId,
        kind: "feedback_request",
        audience: "specific_users",
        source: "agent",
        status: "delivered",
        title: expect.stringMatching(
          /^Scarn is waiting on you in Work item for /,
        ) as string,
        body: "Should the fix target v1 or v2 of the client?",
        recipientUserId: userId,
        payloadJson: { conversationId },
      });
      if (!handOff) {
        throw new Error("Expected a notification");
      }
      const detail = await getNotification(handOff.id);
      expect(
        detail.deliveries.map((delivery) => [
          delivery.channel,
          delivery.status,
        ]),
      ).toEqual([["in_app", "sent"]]);

      await unwrapAsync(reply(conversationId, "Target v2."));
      const continuation = await harness.claimOne(workItemId);
      await yieldTask(continuation, "Keep the old flag?");

      const notifications = await listNotifications(workItemId);
      expect(notifications).toHaveLength(2);
      const continuationRun = await harness.getTaskRun(continuation.taskId);
      expect(continuationRun.taskId).toBe(claimedRun.taskId);
      expect(
        notifications.find(
          (notification) => notification.body === "Keep the old flag?",
        ),
      ).toMatchObject({
        taskId: claimedRun.taskId,
        recipientUserId: userId,
        payloadJson: { conversationId },
      });
    },
    30_000,
  );

  serialTest(
    "a run started by someone else also notifies its starter",
    async () => {
      const { projectId, userId: creatorId } = harness.requireSetup();
      const starter = await createTestUserAndSession({
        email: `notifications-starter-${crypto.randomUUID()}@example.com`,
      });
      await unwrapAsync(
        harness.apiClient.api
          .projects({ projectId })
          .members({ userId: starter.userId })
          .role.put({ role: "write" }, { headers: headers() }),
      );
      const definition = await createPipelineFromDocument(
        harness.apiClient,
        headers(),
        projectId,
        documentFor(harness.requireSetup().stepKey),
      );
      const workItem = await createTestWorkItem(
        harness.apiClient,
        headers(),
        projectId,
        "notifications",
      );
      const workItemId = parseUuidV7(workItem.id);
      await unwrapAsync(
        harness.apiClient.api["pipeline-executions"].post(
          {
            projectId,
            workItemId,
            pipelineDefinitionId: parseUuidV7(definition.id),
          },
          { headers: { ...starter.authHeaders } },
        ),
      );
      await yieldTask(await harness.claimOne(workItemId), "v1 or v2?");

      const creatorView = await listNotifications(workItemId);
      expect(
        creatorView.map((notification) => notification.recipientUserId),
      ).toEqual([creatorId]);

      const starterView = await unwrapAsync(
        harness.apiClient.api.projects({ projectId }).notifications.get({
          query: { workItemId },
          headers: { ...starter.authHeaders },
        }),
      );
      expect(
        starterView.map((notification) => notification.recipientUserId),
      ).toEqual([parseUuidV7(starter.userId)]);
      const [starterNotification] = starterView;
      if (!starterNotification) {
        throw new Error("Expected the starter's notification");
      }
      const hidden = await harness.apiClient.api
        .projects({ projectId })
        .notifications({ notificationId: starterNotification.id })
        .get({ headers: headers() });
      expect(hidden.status).toBe(404);
    },
    30_000,
  );

  serialTest(
    "a reply wait's question notifies the creator once, with no Task",
    async () => {
      const { executionId, workItemId, questionId } = await startWaitingRun();
      const { userId } = harness.requireSetup();

      const notifications = await listNotifications(workItemId);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        pipelineExecutionId: executionId,
        taskId: null,
        kind: "feedback_request",
        audience: "specific_users",
        source: "system",
        status: "delivered",
        body: expect.stringContaining(
          "Which browser were you using?",
        ) as string,
        recipientUserId: userId,
        payloadJson: { questionId },
      });
    },
    30_000,
  );
});

describe("pipeline execution notifications: the project's notification rules", () => {
  const { harness, headers, setUp, startHandedOverRun, listNotifications } =
    createNotificationHarness("pipeline-run-notification-rules");

  beforeAll(async () => {
    await setUp();
  });

  serialTest(
    "a rule turning in-app off suppresses the notification but still records it",
    async () => {
      const { projectId, userId } = harness.requireSetup();
      await unwrapAsync(
        harness.apiClient.api.projects({ projectId })["notification-rules"].put(
          {
            kind: "feedback_request",
            channel: "in_app",
            enabled: false,
            minPriority: null,
            conditionsJson: null,
          },
          { headers: headers() },
        ),
      );

      const { workItemId, conversationId } = await startHandedOverRun();

      const [notification] = await listNotifications(workItemId);
      expect(notification).toMatchObject({
        status: "suppressed",
        recipientUserId: userId,
        payloadJson: { conversationId },
      });
    },
    30_000,
  );
});

import { beforeAll, describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { createAppContext } from "@/lib/di";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createScarnTreaty } from "tests/treaty";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { DrizzleUserNotificationRepo } from "@/notifications/user-notification/infra/drizzle-user-notification-repo";
import { UserNotificationEntity } from "@/notifications/user-notification/domain/user-notification-entity";
import type { AnyJsonObject } from "@/common/contracts/json";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";

const NOW = new Date("2026-04-22T12:00:00.000Z");

const userNotificationRepo = new DrizzleUserNotificationRepo();

const app = createApp(
  createAppContext({
    timeProvider: fixedTimeProvider(NOW),
    userNotificationRepo,
  }),
);
const apiClient = createScarnTreaty(app);

const seedFeedbackRequest = async (
  projectId: UuidV7,
  payloadJson: AnyJsonObject | null,
): Promise<UuidV7> => {
  const created = await userNotificationRepo.create(
    UserNotificationEntity.create({
      projectId,
      workItemId: null,
      pipelineExecutionId: null,
      taskId: null,
      agentSessionId: null,
      recipientUserId: null,
      kind: "feedback_request",
      audience: "assignee",
      title: "Need admin credentials",
      body: "What credentials should I use to log in as an admin?",
      priority: "high",
      source: "agent",
      payloadJson,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
  return created.id;
};

describe("respond to feedback request", () => {
  let project: ProjectContract | undefined;
  let authHeaders: { authorization: string } | undefined;

  beforeAll(async () => {
    const owner = await createTestUserAndSession({
      email: `notification-respond-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Notification Respond Project",
          description: "Project for feedback respond tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
  });

  concurrentTest("records the answer on the notification payload", async () => {
    if (!project || !authHeaders) {
      throw new Error("Expected project setup to complete");
    }

    const notificationId = await seedFeedbackRequest(parseUuidV7(project.id), {
      category: "persona",
    });

    const updated = await unwrapAsync(
      apiClient.api
        .projects({ projectId: project.id })
        .notifications({ notificationId })
        .respond.post(
          { answer: "Use the staging admin account" },
          { headers: { ...authHeaders } },
        ),
    );

    expect(updated.payloadJson).toMatchObject({
      category: "persona",
      response: { answer: "Use the staging admin account" },
    });
  });
});

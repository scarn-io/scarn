import { describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { createAppContext } from "@/lib/di";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { createScarnTreaty } from "tests/treaty";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@/common/contracts/uuid-v7";
import {
  anyJsonObjectSchema,
  type AnyJsonObject,
} from "@/common/contracts/json";
import { DrizzleUserNotificationRepo } from "@/notifications/user-notification/infra/drizzle-user-notification-repo";
import { UserNotificationEntity } from "@/notifications/user-notification/domain/user-notification-entity";
import payloadFixtureJson from "../fixtures/payload.json";

const payloadFixtures = payloadFixtureJson.map((fixture) => ({
  name: fixture.name,
  payloadJson: anyJsonObjectSchema.nullable().parse(fixture.payloadJson),
}));

const userNotificationRepo = new DrizzleUserNotificationRepo();
const apiClient = createScarnTreaty(createApp(createAppContext()));

/**
 * `user_notifications.payload_json` stored-reader fixtures through the
 * repo: each reads back unchanged, and the SQL delete by
 * `payload_json ->> 'conversationId'` matches the pinned key.
 */
const createProject = async (): Promise<UuidV7> => {
  const owner = await createTestUserAndSession({
    email: `notification-payload-${crypto.randomUUID()}@example.com`,
  });
  const project = await unwrapAsync(
    apiClient.api.projects.post(
      {
        name: "Notification Payload Project",
        description: "Project for stored notification payload tests",
        gitUrl: "https://github.com/example/test-project.git",
      },
      { headers: { ...owner.authHeaders } },
    ),
  );
  return parseUuidV7(project.id);
};

const seed = async (
  projectId: UuidV7,
  payloadJson: AnyJsonObject | null,
): Promise<UserNotificationEntity> => {
  const now = new Date();
  return await userNotificationRepo.create(
    UserNotificationEntity.create({
      projectId,
      workItemId: null,
      pipelineExecutionId: null,
      taskId: null,
      agentSessionId: null,
      recipientUserId: null,
      kind: "status_update",
      audience: "project_admins",
      title: "Fixture notification",
      body: "Fixture notification",
      priority: "normal",
      source: "system",
      payloadJson,
      createdAt: now,
      updatedAt: now,
    }),
  );
};

describe("user notification stored payload", () => {
  for (const fixture of payloadFixtures) {
    concurrentTest(`reads the ${fixture.name} fixture back`, async () => {
      const created = await seed(await createProject(), fixture.payloadJson);
      const loaded = await userNotificationRepo.load(created.id);
      expect(loaded?.payloadJson ?? null).toEqual(fixture.payloadJson);
    });
  }

  concurrentTest("deletes by the payload's conversationId", async () => {
    const projectId = await createProject();
    const conversationFixture = payloadFixtures.find(
      (fixture) => typeof fixture.payloadJson?.["conversationId"] === "string",
    );
    const conversationId = conversationFixture?.payloadJson?.["conversationId"];
    if (!conversationFixture || typeof conversationId !== "string") {
      throw new Error("Expected a conversation payload fixture");
    }
    const otherConversation = await seed(projectId, {
      conversationId: createUuidV7(),
    });
    const noPayload = await seed(projectId, null);
    const target = await seed(projectId, conversationFixture.payloadJson);

    const deleted = await userNotificationRepo.deleteByTaskOrConversation({
      projectId,
      taskId: createUuidV7(),
      conversationId: parseUuidV7(conversationId),
    });

    expect(deleted).toBe(1);
    expect(await userNotificationRepo.load(target.id)).toBeNull();
    expect(
      await userNotificationRepo.load(otherConversation.id),
    ).not.toBeNull();
    expect(await userNotificationRepo.load(noPayload.id)).not.toBeNull();
  });
});

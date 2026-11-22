import { beforeAll, describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { createAppContext } from "@/lib/di";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { createScarnTreaty } from "tests/treaty";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { DrizzleUserNotificationRepo } from "@/notifications/user-notification/infra/drizzle-user-notification-repo";
import { UserNotificationEntity } from "@/notifications/user-notification/domain/user-notification-entity";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";

const userNotificationRepo = new DrizzleUserNotificationRepo();
const apiClient = createScarnTreaty(createApp(createAppContext()));

type Session = Awaited<ReturnType<typeof createTestUserAndSession>>;

/**
 * `GET /projects/:projectId/notifications[/:notificationId]` and the dismiss
 * and respond routes show each caller only their own notifications and the
 * project-wide ones.
 */
describe("user notification recipients", () => {
  let owner: Session | undefined;
  let member: Session | undefined;
  let projectId: UuidV7 | undefined;

  beforeAll(async () => {
    owner = await createTestUserAndSession({
      email: `notification-recipients-${crypto.randomUUID()}@example.com`,
    });
    member = await createTestUserAndSession({
      email: `notification-recipients-member-${crypto.randomUUID()}@example.com`,
    });
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Notification Recipients Project",
          description: "Project for per-recipient notification tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    projectId = parseUuidV7(project.id);
    await unwrapAsync(
      apiClient.api
        .projects({ projectId })
        .members({ userId: member.userId })
        .role.put({ role: "write" }, { headers: { ...owner.authHeaders } }),
    );
  });

  const requireSetup = () => {
    if (!owner || !member || !projectId) {
      throw new Error("Expected setup to complete");
    }
    return { owner, member, projectId };
  };

  const seed = async (
    workItemId: UuidV7,
    recipientUserId: string | null,
    title: string,
  ): Promise<UuidV7> => {
    const now = new Date();
    const created = await userNotificationRepo.create(
      UserNotificationEntity.create({
        projectId: requireSetup().projectId,
        workItemId,
        pipelineExecutionId: null,
        taskId: null,
        agentSessionId: null,
        recipientUserId: recipientUserId ? parseUuidV7(recipientUserId) : null,
        kind: "feedback_request",
        audience: "specific_users",
        title,
        body: title,
        priority: "high",
        source: "agent",
        payloadJson: null,
        createdAt: now,
        updatedAt: now,
      }),
    );
    return created.id;
  };

  const routes = () =>
    apiClient.api.projects({ projectId: requireSetup().projectId });

  concurrentTest(
    "lists the caller's own and project-wide notifications",
    async () => {
      const { owner, member, projectId } = requireSetup();
      const workItemId = await seedWorkItem(projectId);
      await seed(workItemId, owner.userId, "For owner");
      await seed(workItemId, member.userId, "For member");
      await seed(workItemId, null, "For everyone");

      const titlesFor = async (session: Session) =>
        (
          await unwrapAsync(
            routes().notifications.get({
              query: { workItemId },
              headers: { ...session.authHeaders },
            }),
          )
        )
          .map((notification) => notification.title)
          .sort();

      expect(await titlesFor(owner)).toEqual(["For everyone", "For owner"]);
      expect(await titlesFor(member)).toEqual(["For everyone", "For member"]);
    },
  );

  concurrentTest(
    "hides someone else's notification from get, dismiss and respond",
    async () => {
      const { owner, member, projectId } = requireSetup();
      const workItemId = await seedWorkItem(projectId);
      const notificationId = await seed(workItemId, owner.userId, "Private");
      const headers = { ...member.authHeaders };
      const notification = routes().notifications({ notificationId });

      const get = await notification.get({ headers });
      const dismiss = await notification.dismiss.post({}, { headers });
      const respond = await notification.respond.post(
        { answer: "Not mine to answer" },
        { headers },
      );

      expect(get.error?.status).toBe(404);
      expect(dismiss.error?.status).toBe(404);
      expect(respond.error?.status).toBe(404);
      const ownView = await unwrapAsync(
        notification.get({ headers: { ...owner.authHeaders } }),
      );
      expect(ownView.recipientUserId).toBe(parseUuidV7(owner.userId));
      expect(ownView.status).toBe("pending");
    },
  );
});

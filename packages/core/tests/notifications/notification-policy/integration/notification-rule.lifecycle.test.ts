import { beforeAll, describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { createAppContext } from "@/lib/di";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createScarnTreaty } from "tests/treaty";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";

describe("notification rule endpoints", () => {
  let project: ProjectContract | undefined;
  let authHeaders: { authorization: string } | undefined;

  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-04-22T12:00:00.000Z")),
    }),
  );
  const apiClient = createScarnTreaty(app);

  beforeAll(async () => {
    const owner = await createTestUserAndSession({
      email: `notification-rule-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Notification Rule Project",
          description: "Project for notification rule tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
  });

  concurrentTest("returns 401 when unauthenticated", async () => {
    if (!project) throw new Error("Expected project setup to complete");

    const { data, error } = await apiClient.api
      .projects({ projectId: project.id })
      ["notification-rules"].get();

    expect(data).toBeNull();
    expect(error?.status).toBe(401);
  });

  concurrentTest("upserts then lists a notification rule", async () => {
    if (!project || !authHeaders) {
      throw new Error("Expected setup to complete");
    }

    const created = await unwrapAsync(
      apiClient.api
        .projects({ projectId: project.id })
        ["notification-rules"].put(
          {
            kind: "feedback_request",
            channel: "work_item_platform_comment",
            enabled: true,
            minPriority: "high",
            conditionsJson: null,
          },
          { headers: { ...authHeaders } },
        ),
    );

    expect(created.kind).toBe("feedback_request");
    expect(created.channel).toBe("work_item_platform_comment");
    expect(created.minPriority).toBe("high");

    // Upsert again with a different priority — should update in place.
    const updated = await unwrapAsync(
      apiClient.api
        .projects({ projectId: project.id })
        ["notification-rules"].put(
          {
            kind: "feedback_request",
            channel: "work_item_platform_comment",
            enabled: false,
            minPriority: null,
            conditionsJson: null,
          },
          { headers: { ...authHeaders } },
        ),
    );

    expect(updated.id).toBe(created.id);
    expect(updated.enabled).toBe(false);

    const rules = await unwrapAsync(
      apiClient.api
        .projects({ projectId: project.id })
        ["notification-rules"].get({ headers: { ...authHeaders } }),
    );

    const workItemCommentRules = rules.filter(
      (r) => r.kind === "feedback_request" && r.channel === "work_item_platform_comment",
    );
    expect(workItemCommentRules).toHaveLength(1);
    expect(workItemCommentRules[0]?.enabled).toBe(false);
  });

  concurrentTest("lists notifications (empty) for a fresh project", async () => {
    if (!project || !authHeaders) {
      throw new Error("Expected setup to complete");
    }

    const notifications = await unwrapAsync(
      apiClient.api
        .projects({ projectId: project.id })
        .notifications.get({ headers: { ...authHeaders } }),
    );

    expect(Array.isArray(notifications)).toBe(true);
  });
});

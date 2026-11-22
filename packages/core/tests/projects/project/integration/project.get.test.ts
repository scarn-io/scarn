import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { createScarnTreaty } from "tests/treaty";
import { describe, expect } from "bun:test";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "./auth-test-utils";
import { v7 as uuidv7 } from "uuid";

describe("project get endpoint", () => {
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-04-24T12:00:00.000Z")),
    }),
  );

  concurrentTest(
    "returns 403 when the authenticated user is not a project member",
    async () => {
      const apiClient = createScarnTreaty(app);
      const owner = await createTestUserAndSession({
        email: `owner-${crypto.randomUUID()}@example.com`,
      });
      const outsider = await createTestUserAndSession({
        email: `outsider-${crypto.randomUUID()}@example.com`,
      });
      const project = await unwrapAsync(
        apiClient.api.projects.post(
          {
            name: "Secret Project",
            description: "Owner only",
            gitUrl: "https://github.com/example/secret-project.git",
          },
          {
            headers: owner.authHeaders,
          },
        ),
      );

      const { data, error } = await apiClient.api
        .projects({ projectId: project.id })
        .get({
          headers: outsider.authHeaders,
        });

      expect(data).toBeNull();
      expect(error?.status).toBe(403);
      expect(error?.value).toMatchObject({
        status: 403,
        code: "PROJECT_FORBIDDEN",
      });
    },
  );

  concurrentTest("returns 404 when the project does not exist", async () => {
    const apiClient = createScarnTreaty(app);
    const user = await createTestUserAndSession({
      email: `user-${crypto.randomUUID()}@example.com`,
    });
    const { data, error } = await apiClient.api
      .projects({ projectId: uuidv7() })
      .get({
        headers: user.authHeaders,
      });

    expect(data).toBeNull();
    expect(error?.status).toBe(404);
  });
});

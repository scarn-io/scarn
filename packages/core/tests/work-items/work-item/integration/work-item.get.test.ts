import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { createScarnTreaty } from "tests/treaty";
import { getDb } from "@/lib/db";
import { projectMemberships } from "@/lib/db/schema";
import { describe, expect } from "bun:test";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { v7 as uuidv7 } from "uuid";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";

describe("work item get endpoint", () => {
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-04-22T12:00:00.000Z")),
    }),
  );
  const apiClient = createScarnTreaty(app);

  concurrentTest(
    "returns 404 when the request is unauthenticated and the work item does not exist",
    async () => {
      // With no session at all, the request never learns the work item's
      // project — and thus its visibility — so it 404s exactly like an
      // authenticated caller would (see the private-project case below for
      // the 401 an unauthenticated caller gets against a *real* work item).
      const { data, error } = await apiClient.api["work-items"]({
        workItemId: uuidv7(),
      }).get();

      expect(data).toBeNull();
      expect(error?.status).toBe(404);
    },
  );

  concurrentTest(
    "returns 401 when the request is unauthenticated and the work item's project is private",
    async () => {
      const owner = await createTestUserAndSession({
        email: `work-item-get-anon-${crypto.randomUUID()}@example.com`,
      });
      const project = await unwrapAsync(
        apiClient.api.projects.post(
          {
            name: "Private Work Item Project",
            description: "Private project used to verify anonymous denial",
            gitUrl: "https://github.com/example/test-project.git",
          },
          {
            headers: { ...owner.authHeaders },
          },
        ),
      );
      const workItem = await unwrapAsync(
        apiClient.api["work-items"].post(
          {
            projectId: project.id,
            platform: "github",
            platformId: `anon-denied-${uuidv7()}`,
            platformKey: `anon-denied-${uuidv7()}`,
            url: "https://github.com/acme/repo/issues/401",
            title: "Anonymous denied",
            description: "Private project work item",
            sourceCreatedAt: null,
            sourceUpdatedAt: null,
            fields: {},
          },
          {
            headers: { ...owner.authHeaders },
          },
        ),
      );

      const { data, error } = await apiClient.api["work-items"]({
        workItemId: workItem.id,
      }).get();

      expect(data).toBeNull();
      expect(error?.status).toBe(401);
    },
  );

  concurrentTest("returns 404 when work item is not found", async () => {
    const user = await createTestUserAndSession({ email: `work-item-get-${crypto.randomUUID()}@example.com` });
    const { data, error } = await apiClient.api["work-items"]({
      workItemId: uuidv7(),
    }).get({ headers: { ...user.authHeaders } });

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.status).toBe(404);
  });

  concurrentTest(
    "returns 403 when the user lacks work item read permission",
    async () => {
      const owner = await createTestUserAndSession({ email: `work-item-get-owner-${crypto.randomUUID()}@example.com` });
      const member = await createTestUserAndSession({ email: `work-item-get-member-${crypto.randomUUID()}@example.com` });
      const project = await unwrapAsync(
        apiClient.api.projects.post(
          {
            name: "Work Item Read Permission Project",
            description: "Project for work item read permission tests",
            gitUrl: "https://github.com/example/test-project.git",
          },
          {
            headers: { ...owner.authHeaders },
          },
        ),
      );
      const workItem = await unwrapAsync(
        apiClient.api["work-items"].post(
          {
            projectId: project.id,
            platform: "github",
            platformId: `read-denied-${uuidv7()}`,
            platformKey: `read-denied-${uuidv7()}`,
            url: "https://github.com/acme/repo/issues/403",
            title: "Read denied",
            description: "Member does not have work item read permission",
            sourceCreatedAt: null,
            sourceUpdatedAt: null,
            fields: {},
          },
          {
            headers: { ...owner.authHeaders },
          },
        ),
      );

      await getDb()
        .insert(projectMemberships)
        .values({
          projectId: project.id,
          userId: member.userId,
          role: "retired-role",
        });

      const { data, error } = await apiClient.api["work-items"]({
        workItemId: workItem.id,
      }).get({ headers: { ...member.authHeaders } });

      expect(data).toBeNull();
      expect(error?.status).toBe(403);
      expect(error?.value).toMatchObject({
        status: 403,
        code: "PROJECT_FORBIDDEN",
      });
    },
  );
});

import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { createScarnTreaty } from "tests/treaty";
import { getDb } from "@/lib/db";
import { projectMemberships } from "@/lib/db/schema";
import { describe, expect } from "bun:test";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "./auth-test-utils";
import { v7 as uuidv7 } from "uuid";

const toIsoString = (value: Date | string | null) =>
  value instanceof Date ? value.toISOString() : value;

describe("project work items get endpoint", () => {
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-04-26T12:00:00.000Z")),
    }),
  );
  const apiClient = createScarnTreaty(app);

  concurrentTest(
    "returns 404 when the request is unauthenticated and the project does not exist",
    async () => {
      // With no session at all, the request never learns the project's
      // visibility, so a nonexistent project 404s exactly like it would for
      // an authenticated caller (see the private-project case below for the
      // 401 an unauthenticated caller gets against a *real* private project).
      const { data, error } = await apiClient.api
        .projects({ projectId: uuidv7() })
        ["work-items"].get();

      expect(data).toBeNull();
      expect(error?.status).toBe(404);
    },
  );

  concurrentTest(
    "returns 401 when the request is unauthenticated and the project is private",
    async () => {
      const owner = await createTestUserAndSession({
        email: `work-items-anon-${crypto.randomUUID()}@example.com`,
      });
      const project = await unwrapAsync(
        apiClient.api.projects.post(
          {
            name: "Private Work Items Project",
            description: "Private project used to verify anonymous denial",
            gitUrl: "https://github.com/example/test-project.git",
          },
          {
            headers: { ...owner.authHeaders },
          },
        ),
      );

      const { data, error } = await apiClient.api
        .projects({ projectId: project.id })
        ["work-items"].get();

      expect(data).toBeNull();
      expect(error?.status).toBe(401);
    },
  );

  concurrentTest("returns 404 when the project does not exist", async () => {
    const user = await createTestUserAndSession({
      email: `user-${crypto.randomUUID()}@example.com`,
    });
    const { data, error } = await apiClient.api
      .projects({ projectId: uuidv7() })
      ["work-items"].get({
        headers: {
          ...user.authHeaders,
        },
      });

    expect(data).toBeNull();
    expect(error?.status).toBe(404);
  });

  concurrentTest(
    "returns 403 when the authenticated user is not allowed to read the project",
    async () => {
      const owner = await createTestUserAndSession({
        email: `owner-${crypto.randomUUID()}@example.com`,
      });
      const member = await createTestUserAndSession({
        email: `member-${crypto.randomUUID()}@example.com`,
      });
      const project = await unwrapAsync(
        apiClient.api.projects.post(
          {
            name: "Project Work Item Permissions",
            description: "Used to verify work item read permissions",
            gitUrl: "https://github.com/example/test-project.git",
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

      const { data, error } = await apiClient.api
        .projects({ projectId: project.id })
        ["work-items"].get({
          headers: {
            ...member.authHeaders,
          },
        });

      expect(data).toBeNull();
      expect(error?.status).toBe(403);
      expect(error?.value).toMatchObject({
        status: 403,
        code: "PROJECT_FORBIDDEN",
      });
    },
  );

  concurrentTest(
    "returns only work items for the requested project in descending updated order",
    async () => {
      const owner = await createTestUserAndSession({
        email: `owner-${crypto.randomUUID()}@example.com`,
      });
      const primaryProject = await unwrapAsync(
        apiClient.api.projects.post(
          {
            name: "Primary Work Item Project",
            description: "Contains the work items under test",
            gitUrl: "https://github.com/example/test-project.git",
          },
          {
            headers: { ...owner.authHeaders },
          },
        ),
      );
      const secondaryProject = await unwrapAsync(
        apiClient.api.projects.post(
          {
            name: "Secondary Work Item Project",
            description: "Used to prove results stay project scoped",
            gitUrl: "https://github.com/example/test-project.git",
          },
          {
            headers: { ...owner.authHeaders },
          },
        ),
      );

      await unwrapAsync(
        apiClient.api["work-items"].post(
          {
            projectId: primaryProject.id,
            platform: "jira",
            platformId: "jira-1",
            platformKey: `VOC-${uuidv7()}`,
            url: "https://jira.example.com/browse/VOC-1",
            title: "Older project work item",
            description: "The older work item for the target project",
            sourceCreatedAt: "2026-04-20T10:00:00.000Z",
            sourceUpdatedAt: "2026-04-21T10:00:00.000Z",
            fields: { severity: "low" },
          },
          {
            headers: { ...owner.authHeaders },
          },
        ),
      );
      await unwrapAsync(
        apiClient.api["work-items"].post(
          {
            projectId: primaryProject.id,
            platform: "github",
            platformId: "github-2",
            platformKey: `2-${uuidv7()}`,
            url: "https://github.com/acme/repo/issues/2",
            title: "Newest project work item",
            description: "The newest work item for the target project",
            sourceCreatedAt: "2026-04-22T10:00:00.000Z",
            sourceUpdatedAt: "2026-04-25T10:00:00.000Z",
            state: "closed",
            fields: { severity: "high" },
          },
          {
            headers: { ...owner.authHeaders },
          },
        ),
      );
      await unwrapAsync(
        apiClient.api["work-items"].post(
          {
            projectId: secondaryProject.id,
            platform: "linear",
            platformId: "linear-3",
            platformKey: `ENG-${uuidv7()}`,
            url: "https://linear.app/acme/issue/ENG-3",
            title: "Other project work item",
            description: "Should not be included",
            sourceCreatedAt: "2026-04-23T10:00:00.000Z",
            sourceUpdatedAt: "2026-04-26T10:00:00.000Z",
            fields: {},
          },
          {
            headers: { ...owner.authHeaders },
          },
        ),
      );

      const { data, error } = await apiClient.api
        .projects({ projectId: primaryProject.id })
        ["work-items"].get({
          headers: {
            ...owner.authHeaders,
          },
        });

      expect(error).toBeNull();
      expect(data).not.toBeNull();
      // No sort requested, so every item's `signalScore` is null and the score
      // column stays hidden in the UI.
      expect(
        data?.items.map((workItem) => ({
          projectId: workItem.projectId,
          title: workItem.title,
          platform: workItem.platform,
          sourceUpdatedAt: toIsoString(workItem.sourceUpdatedAt),
          signalScore: workItem.signalScore,
          state: workItem.state,
          spawnedByTaskId: workItem.spawnedByTaskId,
        })),
      ).toEqual([
        {
          projectId: primaryProject.id,
          title: "Newest project work item",
          platform: "github",
          sourceUpdatedAt: "2026-04-25T10:00:00.000Z",
          signalScore: null,
          state: "closed",
          spawnedByTaskId: null,
        },
        {
          projectId: primaryProject.id,
          title: "Older project work item",
          platform: "jira",
          sourceUpdatedAt: "2026-04-21T10:00:00.000Z",
          signalScore: null,
          state: "open",
          spawnedByTaskId: null,
        },
      ]);
      expect(data?.pagination).toEqual({ page: 1, pageSize: 25, total: 2 });
    },
  );

  // `page`/`pageSize` are validated at the route boundary rather than in the use
  // case, so bad values are a 422 instead of a 500 from a thrown ZodError. Sent
  // as raw requests because the treaty client types them as numbers.
  const rawListRequest = async (
    query: string,
    authorization: string,
  ): Promise<Response> =>
    await app.handle(
      new Request(
        `http://localhost/api/projects/${uuidv7()}/work-items?${query}`,
        { headers: { authorization } },
      ),
    );

  concurrentTest("returns 422 when page is below the minimum", async () => {
    const user = await createTestUserAndSession({
      email: `page-min-${crypto.randomUUID()}@example.com`,
    });
    const response = await rawListRequest(
      "page=0",
      user.authHeaders.authorization,
    );

    expect(response.status).toBe(422);
  });

  concurrentTest("returns 422 when pageSize exceeds the maximum", async () => {
    const user = await createTestUserAndSession({
      email: `page-size-max-${crypto.randomUUID()}@example.com`,
    });
    const response = await rawListRequest(
      "pageSize=101",
      user.authHeaders.authorization,
    );

    expect(response.status).toBe(422);
  });

  concurrentTest("returns 422 when page is not a number", async () => {
    const user = await createTestUserAndSession({
      email: `page-nan-${crypto.randomUUID()}@example.com`,
    });
    const response = await rawListRequest(
      "page=abc",
      user.authHeaders.authorization,
    );

    expect(response.status).toBe(422);
  });

  concurrentTest(
    "does not 422 when sort is an unrecognized token",
    async () => {
      // `sort` is a plain optional string at the route boundary — validation
      // never rejects it. `parseWorkItemSortToken` drops a token it cannot
      // parse instead, so the request proceeds to the same 404 a nonexistent
      // project always gets, never a 422.
      const user = await createTestUserAndSession({
        email: `sort-unrecognized-${crypto.randomUUID()}@example.com`,
      });
      const response = await rawListRequest(
        "sort=bogus",
        user.authHeaders.authorization,
      );

      expect(response.status).toBe(404);
    },
  );
});

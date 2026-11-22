import { beforeAll, describe, expect } from "bun:test";
import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { createScarnTreaty } from "tests/treaty";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { v4 as uuidv7, v7 as realUuidv7 } from "uuid";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";

describe("work item post endpoint", () => {
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-04-22T12:00:00.000Z")),
    }),
  );
  const apiClient = createScarnTreaty(app);
  let project: ProjectContract | undefined;
  let authHeaders: { authorization: string } | undefined;

  beforeAll(async () => {
    const owner = await createTestUserAndSession({
      email: `work-item-post-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Work Item Post Project",
          description: "Project for work item post tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        {
          headers: { ...owner.authHeaders },
        },
      ),
    );
  });

  concurrentTest(
    "returns 401 when the request is unauthenticated",
    async () => {
      if (!project) {
        throw new Error("Expected project auth setup to complete");
      }

      const { data, error } = await apiClient.api["work-items"].post({
        projectId: project.id,
        platform: "github",
        platformId: `unauthenticated-${uuidv7()}`,
        platformKey: `#unauthenticated-${uuidv7()}`,
        url: "https://github.com/acme/repo/issues/401",
        title: "Unauthorized create",
        description: "Should not be created",
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
        fields: {},
      });

      expect(data).toBeNull();
      expect(error?.status).toBe(401);
    },
  );

  concurrentTest(
    "returns a conflict when the work item already exists for the same platform key",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const platformKey = `#${Math.floor(Math.random() * 100000).toString()}`;
      const conflictMessage = `work item github:${platformKey} already exists`;

      await unwrapAsync(
        apiClient.api["work-items"].post(
          {
            projectId: project.id,
            platform: "github",
            platformId: `conflict-${uuidv7()}`,
            platformKey,
            url: "https://github.com/acme/repo/issues/42",
            title: "Original title",
            description: "Original description",
            sourceCreatedAt: null,
            sourceUpdatedAt: null,
            fields: {
              status: "open",
              priority: "high",
            },
          },
          { headers: { ...authHeaders } },
        ),
      );

      const { data, error } = await apiClient.api["work-items"].post(
        {
          projectId: project.id,
          platform: "github",
          platformId: `replacement-${uuidv7()}`,
          platformKey,
          url: "https://github.com/acme/repo/issues/42",
          title: "Updated title",
          description: "Updated description",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          fields: {
            status: "open",
            priority: "medium",
          },
        },
        { headers: { ...authHeaders } },
      );

      expect(data).toBeFalsy();
      expect(error).toBeDefined();
      expect(error?.status).toBe(409);
      expect(error?.value).toMatchObject({
        title: conflictMessage,
        detail: conflictMessage,
        code: "WORK_ITEM_CONFLICT",
      });
    },
  );

  concurrentTest("persists nested fields directly", async () => {
    if (!project || !authHeaders) {
      throw new Error("Expected project auth setup to complete");
    }

    const platformId = `nested-fields-${uuidv7()}`;

    const workItem = await unwrapAsync(
      apiClient.api["work-items"].post(
        {
          projectId: project.id,
          platform: "jira",
          platformId,
          platformKey: `ENG-${String(Math.floor(Math.random() * 100000))}`,
          title: "Persist nested fields",
          description: "Persists the fields object without flattening",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          fields: {
            status: "open",
            metadata: {
              priority: "high",
              retryCount: 3,
              tags: ["customer", "prod"],
            },
            customerVisible: true,
          },
        },
        { headers: { ...authHeaders } },
      ),
    );

    expect(workItem.fields).toEqual({
      status: "open",
      metadata: {
        priority: "high",
        retryCount: 3,
        tags: ["customer", "prod"],
      },
      customerVisible: true,
    });

    const persistedTicket = await unwrapAsync(
      apiClient.api["work-items"]({ workItemId: workItem.id }).get({
        headers: { ...authHeaders },
      }),
    );

    expect(persistedTicket.fields).toEqual({
      status: "open",
      metadata: {
        priority: "high",
        retryCount: 3,
        tags: ["customer", "prod"],
      },
      customerVisible: true,
    });
  });
  concurrentTest(
    "creates the item with the id the caller made, so its platformKey can name it",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }
      const id = parseWorkItemId(realUuidv7());
      const body = {
        id,
        projectId: project.id,
        platform: "scarn" as const,
        platformId: null,
        platformKey: `manual-${id}`,
        url: null,
        title: "Client-made id",
        description: "Its id came from the form",
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
        fields: null,
      };

      const workItem = await unwrapAsync(
        apiClient.api["work-items"].post(body, { headers: { ...authHeaders } }),
      );
      expect(String(workItem.id)).toBe(id);
      expect(workItem.platformKey).toBe(`manual-${id}`);

      const { data, error } = await apiClient.api["work-items"].post(
        { ...body, platformKey: `manual-${realUuidv7()}` },
        { headers: { ...authHeaders } },
      );
      expect(data).toBeNull();
      expect(error?.status).toBe(409);
    },
  );

  concurrentTest("rejects an id that isn't a UUID v7", async () => {
    if (!project || !authHeaders) {
      throw new Error("Expected project auth setup to complete");
    }
    const { data, error } = await apiClient.api["work-items"].post(
      {
        id: crypto.randomUUID(),
        projectId: project.id,
        platform: "scarn",
        platformId: null,
        platformKey: `manual-${realUuidv7()}`,
        url: null,
        title: "Bad id",
        description: "Should not be created",
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
        fields: null,
      },
      { headers: { ...authHeaders } },
    );
    expect(data).toBeNull();
    expect(error?.status).toBe(422);
  });
});

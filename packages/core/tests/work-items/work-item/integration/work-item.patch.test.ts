import { beforeAll, describe, expect } from "bun:test";
import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { createScarnTreaty } from "tests/treaty";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { v7 as uuidv7 } from "uuid";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";

describe("work item patch endpoint", () => {
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
      email: `work-item-patch-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Work Item Patch Project",
          description: "Project for work item patch tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        {
          headers: { ...owner.authHeaders },
        },
      ),
    );
  });

  concurrentTest(
    "the author of a native work item can edit its title and description",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const workItem = await unwrapAsync(
        apiClient.api["work-items"].post(
          {
            projectId: project.id,
            platform: "scarn",
            platformId: null,
            platformKey: `manual-${uuidv7()}`,
            url: null,
            title: "Original title",
            description: "Original description",
            sourceCreatedAt: null,
            sourceUpdatedAt: null,
            fields: null,
          },
          { headers: { ...authHeaders } },
        ),
      );

      const edited = await unwrapAsync(
        apiClient.api["work-items"]({ workItemId: workItem.id }).patch(
          {
            title: "Updated title",
            description: "Updated description",
            descriptionVersion: 1,
          },
          { headers: { ...authHeaders } },
        ),
      );

      expect(edited.id).toBe(workItem.id);
      expect(edited.title).toBe("Updated title");
      expect(edited.description).toBe("Updated description");

      const persisted = await unwrapAsync(
        apiClient.api["work-items"]({ workItemId: workItem.id }).get({
          headers: { ...authHeaders },
        }),
      );

      expect(persisted.title).toBe("Updated title");
      expect(persisted.description).toBe("Updated description");
      expect(persisted.descriptionVersion).toBe(2);
    },
  );

  concurrentTest(
    "a description edit naming a version that has moved is refused with a 409",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const workItem = await unwrapAsync(
        apiClient.api["work-items"].post(
          {
            projectId: project.id,
            platform: "scarn",
            platformId: null,
            platformKey: `manual-${uuidv7()}`,
            url: null,
            title: "Original title",
            description: "Original description",
            sourceCreatedAt: null,
            sourceUpdatedAt: null,
            fields: null,
          },
          { headers: { ...authHeaders } },
        ),
      );
      const route = apiClient.api["work-items"]({ workItemId: workItem.id });
      await unwrapAsync(
        route.patch(
          { description: "First tab's edit", descriptionVersion: 1 },
          { headers: { ...authHeaders } },
        ),
      );

      const { data, error } = await route.patch(
        {
          title: "Second tab's title",
          description: "Second tab's edit",
          descriptionVersion: 1,
        },
        { headers: { ...authHeaders } },
      );

      expect(data).toBeNull();
      expect(error?.status).toBe(409);
      expect(error?.value).toMatchObject({
        code: "WORK_ITEM_DESCRIPTION_CONFLICT",
      });
      const persisted = await unwrapAsync(
        route.get({ headers: { ...authHeaders } }),
      );
      expect(persisted).toMatchObject({
        title: "Original title",
        description: "First tab's edit",
        descriptionVersion: 2,
      });
    },
  );

  concurrentTest(
    "a description edit without a descriptionVersion is refused",
    async () => {
      if (!authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const { error } = await apiClient.api["work-items"]({
        workItemId: uuidv7(),
      }).patch({ description: "Unversioned" }, { headers: { ...authHeaders } });

      expect([400, 422]).toContain(error?.status ?? 0);
    },
  );

  concurrentTest(
    "a synced work item cannot be edited, even by its creator",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const workItem = await unwrapAsync(
        apiClient.api["work-items"].post(
          {
            projectId: project.id,
            platform: "github",
            platformId: `synced-${uuidv7()}`,
            platformKey: `synced-${uuidv7()}`,
            url: "https://github.com/acme/repo/issues/1",
            title: "Synced title",
            description: "Synced description",
            sourceCreatedAt: null,
            sourceUpdatedAt: null,
            fields: {},
          },
          { headers: { ...authHeaders } },
        ),
      );

      const { data, error } = await apiClient.api["work-items"]({
        workItemId: workItem.id,
      }).patch(
        {
          title: "Attempted edit",
          description: "Attempted edit description",
          descriptionVersion: 1,
        },
        { headers: { ...authHeaders } },
      );

      expect(data).toBeNull();
      expect(error?.status).toBe(403);
      expect(error?.value).toMatchObject({
        code: "WORK_ITEM_NOT_NATIVE",
      });
    },
  );

  concurrentTest(
    "a project member who isn't the author cannot edit a native work item",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const owner = authHeaders;
      const other = await createTestUserAndSession({
        email: `work-item-patch-other-${crypto.randomUUID()}@example.com`,
      });

      const workItem = await unwrapAsync(
        apiClient.api["work-items"].post(
          {
            projectId: project.id,
            platform: "scarn",
            platformId: null,
            platformKey: `manual-${uuidv7()}`,
            url: null,
            title: "Owner's title",
            description: "Owner's description",
            sourceCreatedAt: null,
            sourceUpdatedAt: null,
            fields: null,
          },
          { headers: { ...owner } },
        ),
      );

      await unwrapAsync(
        apiClient.api
          .projects({ projectId: project.id })
          .members({ userId: other.userId })
          .role.put({ role: "write" }, { headers: { ...owner } }),
      );

      const { data, error } = await apiClient.api["work-items"]({
        workItemId: workItem.id,
      }).patch(
        {
          title: "Hijacked title",
          description: "Hijacked description",
          descriptionVersion: 1,
        },
        { headers: { ...other.authHeaders } },
      );

      expect(data).toBeNull();
      expect(error?.status).toBe(403);
      expect(error?.value).toMatchObject({
        code: "WORK_ITEM_NOT_AUTHOR",
      });
    },
  );

  concurrentTest(
    "returns 404 for a work item that does not exist",
    async () => {
      if (!authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const { data, error } = await apiClient.api["work-items"]({
        workItemId: uuidv7(),
      }).patch(
        {
          title: "Does not matter",
          description: "Does not matter",
          descriptionVersion: 1,
        },
        { headers: { ...authHeaders } },
      );

      expect(data).toBeNull();
      expect(error?.status).toBe(404);
    },
  );
});

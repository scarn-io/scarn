import { beforeAll, describe, expect } from "bun:test";
import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { createScarnTreaty } from "tests/treaty";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { v4 as uuidv7 } from "uuid";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";

describe("work item put endpoint", () => {
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
      email: `work-item-put-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Work Item Put Project",
          description: "Project for work item put tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        {
          headers: { ...owner.authHeaders },
        },
      ),
    );
  });

  concurrentTest(
    "reingest replaces the whole label list, and leaving labels out keeps them",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }
      const projectId = project.id;
      const headers = { ...authHeaders };
      const platformKey = `acme/repo#${uuidv7()}`;
      const put = async (labels?: string[]) =>
        await unwrapAsync(
          apiClient.api["work-items"].put(
            {
              projectId,
              platform: "github",
              platformKey,
              title: "Labelled",
              description: "Repro",
              sourceCreatedAt: null,
              sourceUpdatedAt: null,
              fields: {},
              ...(labels ? { labels } : {}),
            },
            { headers },
          ),
        );

      expect((await put(["bug", " ux ", "bug"])).labels).toEqual(["bug", "ux"]);
      expect((await put(["ux", "wayfinder:research"])).labels).toEqual([
        "ux",
        "wayfinder:research",
      ]);
      expect((await put()).labels).toEqual(["ux", "wayfinder:research"]);
      expect((await put([])).labels).toEqual([]);
    },
  );

  concurrentTest(
    "reingest updates the current snapshot for the same source work item",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const platformKey = `#${Math.floor(Math.random() * 100000).toString()}`;
      const updatedPlatformId = `reingest-updated-${uuidv7()}`;

      const initialWorkItem = await unwrapAsync(
        apiClient.api["work-items"].put(
          {
            projectId: project.id,
            platform: "github",
            platformId: `reingest-initial-${uuidv7()}`,
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

      const reingestedWorkItem = await unwrapAsync(
        apiClient.api["work-items"].put(
          {
            projectId: project.id,
            platform: "github",
            platformId: updatedPlatformId,
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
        ),
      );

      expect(reingestedWorkItem.id).toBe(initialWorkItem.id);
      expect(reingestedWorkItem.createdAt).toEqual(initialWorkItem.createdAt);
      expect(reingestedWorkItem.platformId).toBe(updatedPlatformId);
      expect(reingestedWorkItem.title).toBe("Updated title");
      expect(reingestedWorkItem.description).toBe("Updated description");
      expect(reingestedWorkItem.fields).toEqual({
        status: "open",
        priority: "medium",
      });

      const persistedWorkItem = await unwrapAsync(
        apiClient.api["work-items"]({ workItemId: reingestedWorkItem.id }).get({
          headers: { ...authHeaders },
        }),
      );

      expect(persistedWorkItem.id).toBe(initialWorkItem.id);
      expect(persistedWorkItem.platformId).toBe(updatedPlatformId);
      expect(persistedWorkItem.title).toBe("Updated title");
      expect(persistedWorkItem.description).toBe("Updated description");
      expect(persistedWorkItem.fields).toEqual({
        status: "open",
        priority: "medium",
      });
    },
  );
});

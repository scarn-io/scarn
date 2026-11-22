import { beforeAll, describe, expect } from "bun:test";
import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { createScarnTreaty } from "tests/treaty";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { v7 as uuidv7 } from "uuid";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";

describe("work item patch labels endpoint", () => {
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
      email: `work-item-patch-labels-owner-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Work Item Labels Project",
          description: "Project for work item label tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
  });

  const setup = () => {
    if (!project || !authHeaders) {
      throw new Error("Expected project auth setup to complete");
    }
    return { project, authHeaders };
  };

  const createItem = async (
    platform: "scarn" | "github",
    labels?: string[],
  ) => {
    const { project, authHeaders } = setup();
    return await unwrapAsync(
      apiClient.api["work-items"].post(
        {
          projectId: project.id,
          platform,
          platformId: platform === "scarn" ? null : `synced-${uuidv7()}`,
          platformKey: `key-${uuidv7()}`,
          url: null,
          title: "Labelled",
          description: "Labelled description",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          fields: null,
          ...(labels === undefined ? {} : { labels }),
        },
        { headers: { ...authHeaders } },
      ),
    );
  };

  concurrentTest("adds then removes labels on a native item", async () => {
    const { authHeaders } = setup();
    const workItem = await createItem("scarn", ["triage"]);
    expect(workItem.labels).toEqual(["triage"]);
    const route = apiClient.api["work-items"]({ workItemId: workItem.id });

    const labelled = await unwrapAsync(
      route.labels.patch(
        { add: [" bug ", "ui", "bug", "triage"], remove: ["triage"] },
        { headers: { ...authHeaders } },
      ),
    );
    expect(labelled.labels).toEqual(["bug", "ui"]);

    const persisted = await unwrapAsync(
      route.get({ headers: { ...authHeaders } }),
    );
    expect(persisted.labels).toEqual(["bug", "ui"]);
  });

  concurrentTest("labels are case-sensitive", async () => {
    const { authHeaders } = setup();
    const workItem = await createItem("scarn", ["Bug"]);

    const labelled = await unwrapAsync(
      apiClient.api["work-items"]({ workItemId: workItem.id }).labels.patch(
        { add: ["bug"], remove: ["BUG"] },
        { headers: { ...authHeaders } },
      ),
    );

    expect(labelled.labels).toEqual(["Bug", "bug"]);
  });

  concurrentTest("refuses a synced item with 409", async () => {
    const { authHeaders } = setup();
    const workItem = await createItem("github");

    const { data, error } = await apiClient.api["work-items"]({
      workItemId: workItem.id,
    }).labels.patch({ add: ["bug"] }, { headers: { ...authHeaders } });

    expect(data).toBeNull();
    expect(error?.status).toBe(409);
    expect(error?.value).toMatchObject({ code: "WORK_ITEM_NOT_NATIVE" });
  });

  concurrentTest("rejects a body with no labels", async () => {
    const { authHeaders } = setup();
    const workItem = await createItem("scarn");

    const { data, error } = await apiClient.api["work-items"]({
      workItemId: workItem.id,
    }).labels.patch({ add: [], remove: [] }, { headers: { ...authHeaders } });

    expect(data).toBeNull();
    expect(error?.status).toBe(422);
  });

  concurrentTest("a read-only member cannot label", async () => {
    const { project, authHeaders } = setup();
    const reader = await createTestUserAndSession({
      email: `work-item-patch-labels-reader-${crypto.randomUUID()}@example.com`,
    });
    await unwrapAsync(
      apiClient.api
        .projects({ projectId: project.id })
        .members({ userId: reader.userId })
        .role.put({ role: "read" }, { headers: { ...authHeaders } }),
    );
    const workItem = await createItem("scarn");

    const { data, error } = await apiClient.api["work-items"]({
      workItemId: workItem.id,
    }).labels.patch({ add: ["bug"] }, { headers: { ...reader.authHeaders } });

    expect(data).toBeNull();
    expect(error?.status).toBe(403);
  });

  concurrentTest("404s for an unknown item", async () => {
    const { authHeaders } = setup();

    const { data, error } = await apiClient.api["work-items"]({
      workItemId: uuidv7(),
    }).labels.patch({ add: ["bug"] }, { headers: { ...authHeaders } });

    expect(data).toBeNull();
    expect(error?.status).toBe(404);
  });
});

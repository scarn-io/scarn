import { beforeAll, describe, expect } from "bun:test";
import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { createScarnTreaty } from "tests/treaty";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { v7 as uuidv7 } from "uuid";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";

const NOW = "2026-04-22T12:00:00.000Z";

describe("work item state endpoint", () => {
  const app = createApp(
    createAppContext({ timeProvider: fixedTimeProvider(new Date(NOW)) }),
  );
  const apiClient = createScarnTreaty(app);
  let project: ProjectContract | undefined;
  let authHeaders: { authorization: string } | undefined;
  let ownerUserId: string | undefined;

  beforeAll(async () => {
    const owner = await createTestUserAndSession({
      email: `work-item-state-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    ownerUserId = owner.userId;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Work Item State Project",
          description: "Project for work item state tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
  });

  const setup = () => {
    if (!project || !authHeaders || !ownerUserId) {
      throw new Error("Expected project auth setup to complete");
    }
    return { project, authHeaders, ownerUserId };
  };

  const createNativeWorkItem = async () => {
    const { project, authHeaders } = setup();
    return await unwrapAsync(
      apiClient.api["work-items"].post(
        {
          projectId: project.id,
          platform: "scarn",
          platformId: null,
          platformKey: `manual-${uuidv7()}`,
          url: null,
          title: "Item to close",
          description: "Description",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          fields: null,
        },
        { headers: { ...authHeaders } },
      ),
    );
  };

  const listComments = async (workItemId: string) => {
    const { authHeaders } = setup();
    return await unwrapAsync(
      apiClient.api["work-item-comments"].get({
        query: { workItemId: parseWorkItemId(workItemId) },
        headers: { ...authHeaders },
      }),
    );
  };

  concurrentTest(
    "closing records the reason, resolution and closer, and posts the resolution as a comment",
    async () => {
      const { authHeaders, ownerUserId } = setup();
      const workItem = await createNativeWorkItem();

      const closed = await unwrapAsync(
        apiClient.api["work-items"]({ workItemId: workItem.id }).state.put(
          {
            state: "closed",
            reason: "superseded",
            resolution: "  Replaced by the new importer.  ",
          },
          { headers: { ...authHeaders } },
        ),
      );

      expect(closed).toMatchObject({
        id: workItem.id,
        state: "closed",
        closeReason: "superseded",
        resolution: "Replaced by the new importer.",
        closedAt: NOW,
        closedByUserId: ownerUserId,
        closedByTaskId: null,
      });

      const persisted = await unwrapAsync(
        apiClient.api["work-items"]({ workItemId: workItem.id }).get({
          headers: { ...authHeaders },
        }),
      );
      expect(persisted).toMatchObject({
        state: "closed",
        closeReason: "superseded",
        resolution: "Replaced by the new importer.",
      });

      const comments = await listComments(workItem.id);
      expect(comments).toHaveLength(1);
      expect(comments[0]).toMatchObject({
        body: "Replaced by the new importer.",
        authorKind: "user",
        authorUserId: ownerUserId,
      });
    },
  );

  concurrentTest(
    "closing with a blank resolution stores null and posts no comment",
    async () => {
      const { authHeaders } = setup();
      const workItem = await createNativeWorkItem();

      const closed = await unwrapAsync(
        apiClient.api["work-items"]({ workItemId: workItem.id }).state.put(
          { state: "closed", reason: "completed", resolution: "   " },
          { headers: { ...authHeaders } },
        ),
      );

      expect(closed.closeReason).toBe("completed");
      expect(closed.resolution).toBeNull();
      expect(await listComments(workItem.id)).toHaveLength(0);
    },
  );

  concurrentTest("reopening clears every closure column", async () => {
    const { authHeaders } = setup();
    const workItem = await createNativeWorkItem();

    await unwrapAsync(
      apiClient.api["work-items"]({ workItemId: workItem.id }).state.put(
        { state: "closed", reason: "out_of_scope", resolution: "Not now." },
        { headers: { ...authHeaders } },
      ),
    );
    const reopened = await unwrapAsync(
      apiClient.api["work-items"]({ workItemId: workItem.id }).state.put(
        { state: "open" },
        { headers: { ...authHeaders } },
      ),
    );

    expect(reopened).toMatchObject({
      state: "open",
      closeReason: null,
      resolution: null,
      closedAt: null,
      closedByUserId: null,
      closedByTaskId: null,
    });

    const persisted = await unwrapAsync(
      apiClient.api["work-items"]({ workItemId: workItem.id }).get({
        headers: { ...authHeaders },
      }),
    );
    expect(persisted.state).toBe("open");
    expect(persisted.closeReason).toBeNull();
    expect(persisted.closedAt).toBeNull();
  });

  concurrentTest(
    "closing an already-closed item is rejected and changes nothing",
    async () => {
      const { authHeaders } = setup();
      const workItem = await createNativeWorkItem();
      await unwrapAsync(
        apiClient.api["work-items"]({ workItemId: workItem.id }).state.put(
          { state: "closed", reason: "completed", resolution: "Done." },
          { headers: { ...authHeaders } },
        ),
      );

      const { data, error } = await apiClient.api["work-items"]({
        workItemId: workItem.id,
      }).state.put(
        { state: "closed", reason: "superseded", resolution: "Again." },
        { headers: { ...authHeaders } },
      );

      expect(data).toBeNull();
      expect(error?.status).toBe(422);
      expect(error?.value).toMatchObject({ code: "WORK_ITEM_ALREADY_CLOSED" });
      expect(await listComments(workItem.id)).toHaveLength(1);
    },
  );

  concurrentTest("a person can close a synced work item", async () => {
    const { project, authHeaders } = setup();
    const workItem = await unwrapAsync(
      apiClient.api["work-items"].put(
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

    const closed = await unwrapAsync(
      apiClient.api["work-items"]({ workItemId: workItem.id }).state.put(
        { state: "closed", reason: "out_of_scope" },
        { headers: { ...authHeaders } },
      ),
    );

    expect(closed.state).toBe("closed");
    expect(closed.closeReason).toBe("out_of_scope");
  });

  concurrentTest(
    "a member without work-items:write cannot close an item",
    async () => {
      const { project, authHeaders } = setup();
      const other = await createTestUserAndSession({
        email: `work-item-state-other-${crypto.randomUUID()}@example.com`,
      });
      await unwrapAsync(
        apiClient.api
          .projects({ projectId: project.id })
          .members({ userId: other.userId })
          .role.put({ role: "read" }, { headers: { ...authHeaders } }),
      );
      const workItem = await createNativeWorkItem();

      const { data, error } = await apiClient.api["work-items"]({
        workItemId: workItem.id,
      }).state.put(
        { state: "closed", reason: "completed" },
        { headers: { ...other.authHeaders } },
      );

      expect(data).toBeNull();
      expect(error?.status).toBe(403);
    },
  );

  concurrentTest(
    "returns 404 for a work item that does not exist",
    async () => {
      const { authHeaders } = setup();

      const { data, error } = await apiClient.api["work-items"]({
        workItemId: uuidv7(),
      }).state.put({ state: "open" }, { headers: { ...authHeaders } });

      expect(data).toBeNull();
      expect(error?.status).toBe(404);
    },
  );

  describe("sync", () => {
    const upsert = async (platformKey: string, state: "open" | "closed") => {
      const { project, authHeaders } = setup();
      return await unwrapAsync(
        apiClient.api["work-items"].put(
          {
            projectId: project.id,
            platform: "github",
            platformId: platformKey,
            platformKey,
            url: "https://github.com/acme/repo/issues/2",
            title: "Synced item",
            description: "Synced description",
            sourceCreatedAt: null,
            sourceUpdatedAt: null,
            fields: {},
            state,
          },
          { headers: { ...authHeaders } },
        ),
      );
    };

    concurrentTest(
      "a sync close sets completed with no resolution or closer, and a sync reopen clears it",
      async () => {
        const platformKey = `sync-${uuidv7()}`;
        const created = await upsert(platformKey, "open");
        expect(created.closeReason).toBeNull();

        const closed = await upsert(platformKey, "closed");
        expect(closed).toMatchObject({
          id: created.id,
          state: "closed",
          closeReason: "completed",
          resolution: null,
          closedAt: NOW,
          closedByUserId: null,
          closedByTaskId: null,
        });
        expect(await listComments(created.id)).toHaveLength(0);

        const reopened = await upsert(platformKey, "open");
        expect(reopened).toMatchObject({
          state: "open",
          closeReason: null,
          resolution: null,
          closedAt: null,
        });
      },
    );

    concurrentTest(
      "a sync that repeats the stored state keeps a person's closure",
      async () => {
        const { authHeaders, ownerUserId } = setup();
        const platformKey = `sync-${uuidv7()}`;
        const created = await upsert(platformKey, "open");
        await unwrapAsync(
          apiClient.api["work-items"]({ workItemId: created.id }).state.put(
            { state: "closed", reason: "superseded", resolution: "Dup." },
            { headers: { ...authHeaders } },
          ),
        );

        const resynced = await upsert(platformKey, "closed");

        expect(resynced).toMatchObject({
          state: "closed",
          closeReason: "superseded",
          resolution: "Dup.",
          closedByUserId: ownerUserId,
        });
      },
    );

    concurrentTest(
      "an item first synced as closed gets a sync closure",
      async () => {
        const created = await upsert(`sync-${uuidv7()}`, "closed");

        expect(created).toMatchObject({
          state: "closed",
          closeReason: "completed",
          resolution: null,
          closedByUserId: null,
        });
      },
    );
  });
});

import { beforeAll, describe, expect } from "bun:test";
import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";
import { createScarnTreaty } from "tests/treaty";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { v7 as uuidv7 } from "uuid";
import {
  createTestUserAndSession,
  type TestUserAndSession,
} from "tests/projects/project/integration/auth-test-utils";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import type { WorkItemContract } from "@/work-items/work-item/contracts/work-item-contracts";

describe("set work item parent", () => {
  const now = new Date("2026-04-22T12:00:00.000Z");
  const appContext = createAppContext({
    timeProvider: fixedTimeProvider(now),
  });
  const app = createApp(appContext);
  const apiClient = createScarnTreaty(app);

  const setParent = (
    workItemId: string,
    parentWorkItemId: string | null,
    headers: { authorization: string },
  ) =>
    apiClient.api["work-items"]({ workItemId }).parent.patch(
      {
        parentWorkItemId:
          parentWorkItemId === null ? null : parseWorkItemId(parentWorkItemId),
      },
      { headers },
    );

  const createProject = async (owner: { authHeaders: { authorization: string } }, name: string) =>
    await unwrapAsync(
      apiClient.api.projects.post(
        {
          name,
          description: `Project for ${name}`,
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );

  const createWorkItem = async (
    owner: { authHeaders: { authorization: string } },
    project: ProjectContract,
    title: string,
  ): Promise<WorkItemContract> =>
    await unwrapAsync(
      apiClient.api["work-items"].post(
        {
          projectId: project.id,
          platform: "scarn",
          platformId: null,
          platformKey: `manual-${uuidv7()}`,
          url: null,
          title,
          description: `Description for ${title}`,
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          fields: null,
        },
        { headers: { ...owner.authHeaders } },
      ),
    );

  let owner: TestUserAndSession | undefined;
  let project: ProjectContract | undefined;

  beforeAll(async () => {
    owner = await createTestUserAndSession({
      email: `work-item-parent-${crypto.randomUUID()}@example.com`,
    });
    project = await createProject(owner, "Work Item Parent Project");
  });

  concurrentTest("sets a parent on a child work item", async () => {
    if (!owner || !project) {
      throw new Error("Expected project auth setup to complete");
    }

    const parent = await createWorkItem(owner, project, "Parent item");
    const child = await createWorkItem(owner, project, "Child item");

    const result = await unwrapAsync(
      setParent(child.id, parent.id, owner.authHeaders),
    );

    expect(result.id).toBe(child.id);
    expect(result.parentWorkItemId).toBe(parseWorkItemId(parent.id));

    const persisted = await unwrapAsync(
      apiClient.api["work-items"]({ workItemId: child.id }).get({
        headers: { ...owner.authHeaders },
      }),
    );
    expect(persisted.parentWorkItemId).toBe(parseWorkItemId(parent.id));

    const children = await unwrapAsync(
      apiClient.api["work-items"]({ workItemId: parent.id }).children.get({
        headers: { ...owner.authHeaders },
      }),
    );
    expect(children.map((c) => c.id)).toContain(child.id);
  });

  concurrentTest("clears a parent on a child work item", async () => {
    if (!owner || !project) {
      throw new Error("Expected project auth setup to complete");
    }

    const parent = await createWorkItem(owner, project, "Parent to clear");
    const child = await createWorkItem(owner, project, "Child to clear");

    await unwrapAsync(setParent(child.id, parent.id, owner.authHeaders));

    const cleared = await unwrapAsync(
      setParent(child.id, null, owner.authHeaders),
    );

    expect(cleared.parentWorkItemId).toBeNull();
  });

  concurrentTest(
    "rejects a parent that belongs to a different project",
    async () => {
      if (!owner || !project) {
        throw new Error("Expected project auth setup to complete");
      }

      const otherProject = await createProject(
        owner,
        "Other Project For Cross-Project Rejection",
      );
      const child = await createWorkItem(owner, project, "Cross-project child");
      const foreignParent = await createWorkItem(
        owner,
        otherProject,
        "Foreign parent",
      );

      const { data, error } = await setParent(
        child.id,
        foreignParent.id,
        owner.authHeaders,
      );

      expect(data).toBeFalsy();
      expect(error?.status).toBe(422);
      expect(error?.value).toMatchObject({
        code: "WORK_ITEM_PARENT_CROSS_PROJECT",
      });
    },
  );

  concurrentTest("rejects a work item being set as its own parent", async () => {
    if (!owner || !project) {
      throw new Error("Expected project auth setup to complete");
    }

    const workItem = await createWorkItem(owner, project, "Self parent item");

    const { data, error } = await setParent(
      workItem.id,
      workItem.id,
      owner.authHeaders,
    );

    expect(data).toBeFalsy();
    expect(error?.status).toBe(422);
    expect(error?.value).toMatchObject({
      code: "WORK_ITEM_SELF_PARENT",
    });
  });

  concurrentTest(
    "rejects setting a parent that would create a cycle",
    async () => {
      if (!owner || !project) {
        throw new Error("Expected project auth setup to complete");
      }

      const itemA = await createWorkItem(owner, project, "Cycle item A");
      const itemB = await createWorkItem(owner, project, "Cycle item B");

      // A -> B (B is A's parent).
      await unwrapAsync(setParent(itemA.id, itemB.id, owner.authHeaders));

      // B -> A would close the cycle.
      const { data, error } = await setParent(
        itemB.id,
        itemA.id,
        owner.authHeaders,
      );

      expect(data).toBeFalsy();
      expect(error?.status).toBe(422);
      expect(error?.value).toMatchObject({
        code: "WORK_ITEM_PARENT_CYCLE",
      });
    },
  );

  concurrentTest(
    "orphans a child when its parent work item is deleted",
    async () => {
      if (!owner || !project) {
        throw new Error("Expected project auth setup to complete");
      }

      const parent = await createWorkItem(owner, project, "Parent to delete");
      const child = await createWorkItem(owner, project, "Orphaned child");

      await unwrapAsync(setParent(child.id, parent.id, owner.authHeaders));

      await unwrapAsync(
        apiClient.api["work-items"]({ workItemId: parent.id }).delete(
          undefined,
          { headers: { ...owner.authHeaders } },
        ),
      );

      // Kept on direct repo access rather than the API client: there is no
      // GET-children/orphan-check endpoint (deferred per the plan — see
      // Phase 4's report), so re-fetching the child by id and inspecting
      // `parentWorkItemId` is the only way to observe the cascading orphan
      // without adding new API surface out of scope for this ticket.
      const reloaded = await appContext.workItemRepo.load(
        parseWorkItemId(child.id),
      );
      expect(reloaded?.parentWorkItemId).toBeNull();
    },
  );

  concurrentTest(
    "rejects a caller who lacks work-items:update on the target's project",
    async () => {
      if (!owner || !project) {
        throw new Error("Expected project auth setup to complete");
      }

      const outsider = await createTestUserAndSession({
        email: `work-item-parent-outsider-${crypto.randomUUID()}@example.com`,
      });
      const parent = await createWorkItem(owner, project, "Guarded parent");
      const child = await createWorkItem(owner, project, "Guarded child");

      const { data, error } = await setParent(
        child.id,
        parent.id,
        outsider.authHeaders,
      );

      expect(data).toBeFalsy();
      expect(error?.status).toBe(403);
      expect(error?.value).toMatchObject({
        code: "PROJECT_FORBIDDEN",
      });
    },
  );
});

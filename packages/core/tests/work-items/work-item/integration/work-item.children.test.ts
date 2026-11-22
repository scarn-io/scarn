import { eq } from "drizzle-orm";
import { createAppContext } from "@/lib/di";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { createApp } from "@scarn/api/app";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";
import { workItemSchema } from "@/work-items/work-item/contracts/work-item-contracts";
import { createScarnTreaty } from "tests/treaty";
import { describe, expect } from "bun:test";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { v7 as uuidv7 } from "uuid";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import type { WorkItemContract } from "@/work-items/work-item/contracts/work-item-contracts";

/**
 * No `fixedTimeProvider` override here (unlike most sibling work-item
 * integration test files) — the ordering assertion below depends on
 * successive work items actually getting distinct `createdAt` values from
 * the real clock, which a frozen time provider would collapse to one
 * instant.
 */
describe("work item children endpoint", () => {
  const app = createApp(createAppContext());
  const apiClient = createScarnTreaty(app);

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  const createProject = async (
    owner: { authHeaders: { authorization: string } },
    name: string,
  ) =>
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

  const markPublic = async (projectId: string): Promise<void> => {
    await getDb()
      .update(projects)
      .set({ visibility: "public" })
      .where(eq(projects.id, projectId));
  };

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

  const setParent = (
    workItemId: string,
    parentWorkItemId: string,
    headers: { authorization: string },
  ) =>
    unwrapAsync(
      apiClient.api["work-items"]({ workItemId }).parent.patch(
        { parentWorkItemId: parseWorkItemId(parentWorkItemId) },
        { headers },
      ),
    );

  const getChildren = (
    workItemId: string,
    headers?: { authorization: string },
  ) =>
    headers
      ? apiClient.api["work-items"]({ workItemId }).children.get({ headers })
      : apiClient.api["work-items"]({ workItemId }).children.get();

  concurrentTest(
    "returns direct children ordered by createdAt, independent of parenting order or title",
    async () => {
      const owner = await createTestUserAndSession({
        email: `work-item-children-order-${crypto.randomUUID()}@example.com`,
      });
      const project = await createProject(owner, "Children Order Project");
      const parent = await createWorkItem(owner, project, "Ordering parent");

      const childA = await createWorkItem(
        owner,
        project,
        "Third alphabetically, first created",
      );
      await sleep(5);
      const childB = await createWorkItem(
        owner,
        project,
        "First alphabetically, second created",
      );
      await sleep(5);
      const childC = await createWorkItem(
        owner,
        project,
        "Second alphabetically, third created",
      );

      // Parented in reverse-creation order, to prove response ordering
      // tracks `createdAt`, not the order parents were assigned.
      await setParent(childC.id, parent.id, owner.authHeaders);
      await setParent(childA.id, parent.id, owner.authHeaders);
      await setParent(childB.id, parent.id, owner.authHeaders);

      const children = await unwrapAsync(
        getChildren(parent.id, owner.authHeaders),
      );

      expect(children.map((child) => child.id)).toEqual([
        childA.id,
        childB.id,
        childC.id,
      ]);
    },
  );

  concurrentTest(
    "returns an empty array for a work item with no children",
    async () => {
      const owner = await createTestUserAndSession({
        email: `work-item-children-empty-${crypto.randomUUID()}@example.com`,
      });
      const project = await createProject(owner, "Childless Project");
      const workItem = await createWorkItem(owner, project, "Childless item");

      const { data, error } = await getChildren(workItem.id, owner.authHeaders);

      expect(error).toBeNull();
      expect(data).toEqual([]);
    },
  );

  concurrentTest(
    "returns 404 when the parent work item does not exist",
    async () => {
      const owner = await createTestUserAndSession({
        email: `work-item-children-404-${crypto.randomUUID()}@example.com`,
      });

      const { data, error } = await getChildren(uuidv7(), owner.authHeaders);

      expect(data).toBeNull();
      expect(error?.status).toBe(404);
    },
  );

  concurrentTest(
    "returns 403 when a logged-in non-member reads a private project's parent",
    async () => {
      const owner = await createTestUserAndSession({
        email: `work-item-children-owner-${crypto.randomUUID()}@example.com`,
      });
      const outsider = await createTestUserAndSession({
        email: `work-item-children-outsider-${crypto.randomUUID()}@example.com`,
      });
      const project = await createProject(owner, "Private Children Project");
      const parent = await createWorkItem(owner, project, "Private parent");

      const { data, error } = await getChildren(
        parent.id,
        outsider.authHeaders,
      );

      expect(data).toBeNull();
      expect(error?.status).toBe(403);
      expect(error?.value).toMatchObject({ code: "PROJECT_FORBIDDEN" });
    },
  );

  concurrentTest(
    "allows an anonymous caller to read a public project's children",
    async () => {
      const owner = await createTestUserAndSession({
        email: `work-item-children-anon-${crypto.randomUUID()}@example.com`,
      });
      const project = await createProject(owner, "Public Children Project");
      await markPublic(project.id);
      const parent = await createWorkItem(owner, project, "Public parent");
      const child = await createWorkItem(owner, project, "Public child");
      await setParent(child.id, parent.id, owner.authHeaders);

      const { data, error } = await getChildren(parent.id);

      expect(error).toBeNull();
      expect(data?.map((c) => c.id)).toEqual([child.id]);
    },
  );

  concurrentTest(
    "excludes grandchildren -- only direct children are returned",
    async () => {
      const owner = await createTestUserAndSession({
        email: `work-item-children-grandchild-${crypto.randomUUID()}@example.com`,
      });
      const project = await createProject(owner, "Grandchild Project");
      const parent = await createWorkItem(owner, project, "Grandparent");
      const child = await createWorkItem(owner, project, "Middle child");
      const grandchild = await createWorkItem(owner, project, "Grandchild");

      await setParent(child.id, parent.id, owner.authHeaders);
      await setParent(grandchild.id, child.id, owner.authHeaders);

      const children = await unwrapAsync(
        getChildren(parent.id, owner.authHeaders),
      );

      expect(children.map((c) => c.id)).toEqual([child.id]);
    },
  );

  concurrentTest(
    "excludes children that belong to a different parent",
    async () => {
      const owner = await createTestUserAndSession({
        email: `work-item-children-cross-parent-${crypto.randomUUID()}@example.com`,
      });
      const project = await createProject(owner, "Cross Parent Project");
      const parentA = await createWorkItem(owner, project, "Parent A");
      const parentB = await createWorkItem(owner, project, "Parent B");
      const childOfA = await createWorkItem(owner, project, "Child of A");
      const childOfB = await createWorkItem(owner, project, "Child of B");

      await setParent(childOfA.id, parentA.id, owner.authHeaders);
      await setParent(childOfB.id, parentB.id, owner.authHeaders);

      const childrenOfA = await unwrapAsync(
        getChildren(parentA.id, owner.authHeaders),
      );

      expect(childrenOfA.map((c) => c.id)).toEqual([childOfA.id]);
    },
  );

  concurrentTest(
    "returns the full work item contract shape, including resolved creator display fields",
    async () => {
      const username = `children-creator-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const image = "https://example.com/children-creator.png";
      const owner = await createTestUserAndSession({
        email: `work-item-children-shape-${crypto.randomUUID()}@example.com`,
        username,
        image,
      });
      const project = await createProject(owner, "Children Shape Project");
      const parent = await createWorkItem(owner, project, "Shape parent");
      const child = await createWorkItem(owner, project, "Shape child");
      await setParent(child.id, parent.id, owner.authHeaders);

      const children = await unwrapAsync(
        getChildren(parent.id, owner.authHeaders),
      );

      expect(children).toHaveLength(1);
      const [returnedChild] = children;
      expect(() => workItemSchema.parse(returnedChild)).not.toThrow();
      expect(returnedChild).toMatchObject({
        id: child.id,
        projectId: project.id,
        title: "Shape child",
        parentWorkItemId: parseWorkItemId(parent.id),
        createdByUserId: owner.userId,
        createdByUsername: username,
        createdByImage: image,
      });
    },
  );
});

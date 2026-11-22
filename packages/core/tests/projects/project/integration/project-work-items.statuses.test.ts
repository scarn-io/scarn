import { beforeAll, describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import {
  createUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import { getDb } from "@/lib/db";
import { tasks } from "@/lib/db/schema";
import type { TaskStatus } from "@/tasks/task/domain/task-entity";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { agentTaskInstructionColumns } from "tests/lib/db/seed-task-prerequisites";
import { createTestUserAndSession } from "./auth-test-utils";
import {
  createListingProject,
  seedWorkItems,
  type ListingProject,
} from "./work-item-listing-test-support";

/**
 * `GET /projects/:projectId/work-item-statuses?ids=a,b`: the live title and
 * status of each asked-for work item in the project, for work item links.
 */
describe("project work item statuses", () => {
  const apiClient = createScarnTreaty(createApp(createAppContext()));
  let project: ListingProject | undefined;
  let otherProject: ListingProject | undefined;

  beforeAll(async () => {
    [project, otherProject] = await Promise.all([
      createListingProject(apiClient, "statuses"),
      createListingProject(apiClient, "statuses-other"),
    ]);
  });

  const fixture = () => {
    if (!project || !otherProject) {
      throw new Error("Expected the statuses fixture to be set up");
    }
    return { project, otherProject };
  };

  const seed = async (target: ListingProject, title: string) => {
    const [item] = await seedWorkItems(apiClient, target, [
      { title, platform: "scarn" },
    ]);
    if (!item) throw new Error("Expected a seeded work item");
    return item.id;
  };

  const seedTask = async (workItemId: UuidV7, status: TaskStatus) => {
    await getDb()
      .insert(tasks)
      .values({
        id: createUuidV7(),
        projectId: fixture().project.projectId,
        workItemId,
        ...agentTaskInstructionColumns,
        status,
      });
  };

  const statusesOf = (ids: string, target = fixture().project) =>
    apiClient.api
      .projects({ projectId: target.projectId })
      ["work-item-statuses"].get({
        query: { ids },
        headers: { ...target.authHeaders },
      });

  concurrentTest(
    "returns each item's live title and status, in the order asked",
    async () => {
      const { project } = fixture();
      const [neverRan, running, blocked, blocker, closed] = await Promise.all([
        seed(project, "Never ran"),
        seed(project, "Running"),
        seed(project, "Blocked"),
        seed(project, "Blocker"),
        seed(project, "Closed"),
      ]);
      await seedTask(running, "running");
      await seedTask(blocker, "succeeded");
      await unwrapAsync(
        apiClient.api["work-item-blocks"].post(
          {
            blockedWorkItemId: parseWorkItemId(blocked),
            blockingWorkItemId: parseWorkItemId(blocker),
          },
          { headers: { ...project.authHeaders } },
        ),
      );
      await unwrapAsync(
        apiClient.api["work-items"]({ workItemId: closed }).state.put(
          { state: "closed", reason: "completed", resolution: "Done" },
          { headers: { ...project.authHeaders } },
        ),
      );

      const statuses = await unwrapAsync(
        statusesOf([closed, blocker, blocked, running, neverRan].join(",")),
      );

      expect(statuses).toEqual([
        { id: closed, title: "Closed", status: "closed" },
        { id: blocker, title: "Blocker", status: "ready" },
        { id: blocked, title: "Blocked", status: "blocked" },
        { id: running, title: "Running", status: "running" },
        { id: neverRan, title: "Never ran", status: "needs_person" },
      ]);
    },
    30_000,
  );

  concurrentTest(
    "leaves out items in other projects, deleted items and ids that aren't work items",
    async () => {
      const { project, otherProject } = fixture();
      const [kept, deleted, elsewhere] = await Promise.all([
        seed(project, "Kept"),
        seed(project, "Deleted"),
        seed(otherProject, "Elsewhere"),
      ]);
      await unwrapAsync(
        apiClient.api["work-items"]({ workItemId: deleted }).delete(undefined, {
          headers: { ...project.authHeaders },
        }),
      );

      const statuses = await unwrapAsync(
        statusesOf(
          [
            deleted,
            elsewhere,
            createUuidV7(),
            "not-a-uuid",
            crypto.randomUUID(),
            kept,
            kept,
          ].join(","),
        ),
      );

      expect(statuses).toEqual([
        { id: kept, title: "Kept", status: "needs_person" },
      ]);
    },
  );

  concurrentTest("with no ids, returns nothing", async () => {
    expect(await unwrapAsync(statusesOf(""))).toEqual([]);
  });

  concurrentTest("refuses a caller outside a private project", async () => {
    const stranger = await createTestUserAndSession({
      email: `statuses-stranger-${crypto.randomUUID()}@example.com`,
    });
    const { error } = await apiClient.api
      .projects({ projectId: fixture().project.projectId })
      ["work-item-statuses"].get({
        query: { ids: createUuidV7() },
        headers: { ...stranger.authHeaders },
      });

    expect(error?.status).toBe(403);
  });
});

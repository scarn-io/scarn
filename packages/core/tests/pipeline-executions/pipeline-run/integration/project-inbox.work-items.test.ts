import { beforeAll, describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "@scarn/api/app";
import { SYSTEM_ACTOR_ID } from "@scarn/core/access/authorization/system-actor";
import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import { getDb } from "@/lib/db";
import {
  conversations,
  tasks,
  workItemBlocks,
  workItems,
} from "@/lib/db/schema";
import type { TaskStatus } from "@/tasks/task/domain/task-entity";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";

type Session = Awaited<ReturnType<typeof createTestUserAndSession>>;

/** The inbox's "Work items waiting on you": `GET …/inbox/waits` `workItems` and the badge. */
describe("project inbox work items", () => {
  let apiClient: ReturnType<typeof createScarnTreaty>;
  let owner: Session | undefined;

  beforeAll(async () => {
    apiClient = createScarnTreaty(createApp(createAppContext()));
    owner = await createTestUserAndSession({
      email: `inbox-work-items-${crypto.randomUUID()}@example.com`,
    });
  });

  const requireOwner = () => {
    if (!owner) throw new Error("Expected setup to complete");
    return owner;
  };

  const createProject = async () => {
    const projectId = parseUuidV7(
      (
        await unwrapAsync(
          apiClient.api.projects.post(
            {
              name: `Inbox Work Items ${crypto.randomUUID()}`,
              description: "Project for the inbox's work items",
              gitUrl: "https://github.com/example/test-project.git",
            },
            { headers: { ...requireOwner().authHeaders } },
          ),
        )
      ).id,
    );
    const member = await createTestUserAndSession({
      email: `inbox-work-items-member-${crypto.randomUUID()}@example.com`,
    });
    await unwrapAsync(
      apiClient.api
        .projects({ projectId })
        .members({ userId: member.userId })
        .role.put(
          { role: "read" },
          { headers: { ...requireOwner().authHeaders } },
        ),
    );
    return { projectId, member };
  };

  /** A work item with no assignee, creator or parent unless given. */
  const seedItem = async (
    projectId: UuidV7,
    input: {
      createdByUserId?: string;
      assigneeUserId?: string;
      parentWorkItemId?: UuidV7;
      labels?: string[];
      closed?: boolean;
    } = {},
  ) => {
    const id = await seedWorkItem(projectId);
    await getDb()
      .update(workItems)
      .set({
        createdByUserId: input.createdByUserId
          ? parseUuidV7(input.createdByUserId)
          : null,
        assigneeUserId: input.assigneeUserId
          ? parseUuidV7(input.assigneeUserId)
          : null,
        parentWorkItemId: input.parentWorkItemId ?? null,
        labels: input.labels ?? [],
        ...(input.closed
          ? { state: "closed", closeReason: "completed", closedAt: new Date() }
          : {}),
      })
      .where(eq(workItems.id, id));
    return id;
  };

  const seedTask = async (
    projectId: UuidV7,
    workItemId: UuidV7,
    status: TaskStatus = "succeeded",
  ) => {
    const conversationId =
      status === "waiting_for_person" ? createUuidV7() : null;
    if (conversationId) {
      await getDb().insert(conversations).values({
        id: conversationId,
        projectId,
        workItemId,
        status: "waiting_for_person",
      });
    }
    await getDb().insert(tasks).values({
      id: createUuidV7(),
      projectId,
      workItemId,
      kind: "agent",
      prompt: "Do the thing.",
      status,
      schemaVersion: 1,
      conversationId,
    });
  };

  const block = async (
    projectId: UuidV7,
    blockedWorkItemId: UuidV7,
    blockingWorkItemId: UuidV7,
  ) => {
    await getDb().insert(workItemBlocks).values({
      id: createUuidV7(),
      projectId,
      blockedWorkItemId,
      blockingWorkItemId,
    });
  };

  const inbox = (projectId: UuidV7, session: Session = requireOwner()) => {
    const route = apiClient.api.projects({ projectId }).inbox;
    const headers = { ...session.authHeaders };
    return {
      workItems: async () =>
        (await unwrapAsync(route.waits.get({ headers }))).workItems,
      summary: async () => await unwrapAsync(route.summary.get({ headers })),
    };
  };

  concurrentTest(
    "a ready item with no Task waits on its assignee, then its creator",
    async () => {
      const { userId } = requireOwner();
      const { projectId, member } = await createProject();
      const assigned = await seedItem(projectId, {
        assigneeUserId: userId,
        createdByUserId: member.userId,
        labels: ["wayfinder:task"],
      });
      const created = await seedItem(projectId, { createdByUserId: userId });
      const theirs = await seedItem(projectId, {
        createdByUserId: member.userId,
      });

      const mine = await inbox(projectId).workItems();
      const memberItems = await inbox(projectId, member).workItems();

      expect(mine.map((item) => item.id).sort()).toEqual(
        [assigned, created].sort(),
      );
      expect(mine.find((item) => item.id === assigned)).toMatchObject({
        labels: ["wayfinder:task"],
        parent: null,
        waitingOn: [
          { userId: parseUuidV7(userId) },
          { userId: parseUuidV7(member.userId) },
        ],
      });
      expect(memberItems.map((item) => item.id).sort()).toEqual(
        [assigned, theirs].sort(),
      );
    },
  );

  concurrentTest(
    "an item with neither waits on its nearest parent's people, over two levels",
    async () => {
      const { userId } = requireOwner();
      const { projectId, member } = await createProject();
      const map = await seedItem(projectId, { createdByUserId: userId });
      await seedTask(projectId, map);
      const middle = await seedItem(projectId, {
        parentWorkItemId: map,
        createdByUserId: SYSTEM_ACTOR_ID,
      });
      await seedTask(projectId, middle);
      const child = await seedItem(projectId, { parentWorkItemId: middle });
      const assignedParent = await seedItem(projectId, {
        assigneeUserId: member.userId,
        parentWorkItemId: map,
      });
      await seedTask(projectId, assignedParent);
      const memberChild = await seedItem(projectId, {
        parentWorkItemId: assignedParent,
      });

      const mine = await inbox(projectId).workItems();

      expect(mine.map((item) => item.id)).toEqual([child]);
      const [row] = mine;
      expect(row?.parent).toEqual({
        id: middle,
        title: expect.any(String) as string,
      });
      expect(row?.waitingOn.map((person) => person.userId)).toEqual([
        parseUuidV7(userId),
      ]);
      expect(
        (await inbox(projectId, member).workItems()).map((item) => item.id),
      ).toEqual([memberChild]);
    },
  );

  concurrentTest(
    "leaves out items with a Task, open blockers or that are closed",
    async () => {
      const { userId } = requireOwner();
      const { projectId } = await createProject();
      const ready = await seedItem(projectId, { createdByUserId: userId });
      const hadTask = await seedItem(projectId, { createdByUserId: userId });
      await seedTask(projectId, hadTask, "failed");
      const blocked = await seedItem(projectId, { createdByUserId: userId });
      const openBlocker = await seedItem(projectId, { closed: false });
      await seedTask(projectId, openBlocker);
      await block(projectId, blocked, openBlocker);
      const unblocked = await seedItem(projectId, { createdByUserId: userId });
      const closedBlocker = await seedItem(projectId, { closed: true });
      await block(projectId, unblocked, closedBlocker);
      await seedItem(projectId, { createdByUserId: userId, closed: true });

      const mine = await inbox(projectId).workItems();

      expect(mine.map((item) => item.id).sort()).toEqual(
        [ready, unblocked].sort(),
      );
    },
  );

  concurrentTest(
    "the badge counts the work items, and a waiting Task walks the parents too",
    async () => {
      const { userId } = requireOwner();
      const { projectId, member } = await createProject();
      const map = await seedItem(projectId, { createdByUserId: userId });
      await seedTask(projectId, map);
      const middle = await seedItem(projectId, { parentWorkItemId: map });
      await seedTask(projectId, middle);
      await seedItem(projectId, { parentWorkItemId: middle });
      const waiting = await seedItem(projectId, { parentWorkItemId: middle });
      await seedTask(projectId, waiting, "waiting_for_person");

      expect(await inbox(projectId).summary()).toEqual({
        waitingOnMe: 1,
        failedStartedByMe: 0,
        pipelineWaitsOnMe: 0,
        workItemsWaitingOnMe: 1,
        badgeCount: 2,
        waitingOnOthers: 0,
      });
      expect(await inbox(projectId, member).summary()).toMatchObject({
        waitingOnMe: 0,
        workItemsWaitingOnMe: 0,
        badgeCount: 0,
        waitingOnOthers: 1,
      });
      const waitingTasks = await unwrapAsync(
        apiClient.api.projects({ projectId }).tasks.get({
          query: { waitingOnMe: true },
          headers: { ...requireOwner().authHeaders },
        }),
      );
      expect(
        waitingTasks.tasks.map((task) =>
          task.waitingOn.map((person) => person.userId),
        ),
      ).toEqual([[parseUuidV7(userId)]]);
    },
  );
});

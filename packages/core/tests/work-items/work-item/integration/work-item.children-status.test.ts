import { beforeAll, describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "@scarn/api/app";
import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import { getDb } from "@/lib/db";
import {
  conversationMessages,
  conversations,
  tasks,
  workItems,
} from "@/lib/db/schema";
import type { TaskStatus } from "@/tasks/task/domain/task-entity";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";
import { childWorkItemSchema } from "@/work-items/work-item/contracts/child-work-item-contracts";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import {
  agentTaskInstructionColumns,
  seedWorkItem,
} from "tests/lib/db/seed-task-prerequisites";
import { seedTaskRun } from "tests/tasks/task/integration/project-tasks-test-support";

type Owner = Awaited<ReturnType<typeof createTestUserAndSession>>;

/**
 * The children endpoint's status rule and the fields the children section
 * shows: each child's status, assignee, open blockers' titles and newest
 * Task (its step, first start, question or failure).
 */
describe("work item children status", () => {
  const apiClient = createScarnTreaty(createApp(createAppContext()));
  let owner: Owner | undefined;
  let projectId: UuidV7 | undefined;

  beforeAll(async () => {
    owner = await createTestUserAndSession({
      email: `work-item-children-status-${crypto.randomUUID()}@example.com`,
    });
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Children Status Project",
          description: "Project for child work item status tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    projectId = parseUuidV7(project.id);
  });

  const requireSetup = () => {
    if (!owner || !projectId) {
      throw new Error("Expected setup to complete");
    }
    return { owner, projectId, headers: { ...owner.authHeaders } };
  };

  const seedChild = async (
    parentId: UuidV7 | null,
    values: { title?: string; assigneeUserId?: UuidV7 } = {},
  ) => {
    const id = await seedWorkItem(requireSetup().projectId);
    await getDb()
      .update(workItems)
      .set({ parentWorkItemId: parentId, ...values })
      .where(eq(workItems.id, id));
    return id;
  };

  const createStep = async () => {
    const { projectId, headers } = requireSetup();
    const created = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        {
          projectId,
          key: `children_status_${crypto.randomUUID()}`,
          name: "Research",
          description: "Step for child status tests",
          prompt: "Research it.",
          version: 1,
          kind: "user_defined",
          inputSchemaJson: { type: "object" },
          resultSchemaJson: { type: "object" },
          status: "active",
          repo: { mode: "readOnly" },
        },
        { headers },
      ),
    );
    return { id: parseUuidV7(created.id), key: created.key };
  };

  const seedTask = async (
    workItemId: UuidV7,
    status: TaskStatus,
    values: {
      stepDefinitionId?: UuidV7;
      errorJson?: unknown;
      conversationId?: UuidV7;
      createdAt?: Date;
    } = {},
  ) => {
    const id = createUuidV7();
    await getDb()
      .insert(tasks)
      .values({
        id,
        projectId: requireSetup().projectId,
        workItemId,
        ...agentTaskInstructionColumns,
        status,
        schemaVersion: 1,
        ...values,
      });
    return id;
  };

  const seedQuestion = async (workItemId: UuidV7, body: string) => {
    const conversationId = createUuidV7();
    await getDb().insert(conversations).values({
      id: conversationId,
      projectId: requireSetup().projectId,
      workItemId,
      status: "waiting_for_person",
    });
    await getDb().insert(conversationMessages).values({
      id: createUuidV7(),
      conversationId,
      authorKind: "agent",
      body,
    });
    return conversationId;
  };

  const block = async (blocked: UuidV7, blocking: UuidV7) =>
    await unwrapAsync(
      apiClient.api["work-item-blocks"].post(
        {
          blockedWorkItemId: parseWorkItemId(blocked),
          blockingWorkItemId: parseWorkItemId(blocking),
        },
        { headers: requireSetup().headers },
      ),
    );

  const close = async (workItemId: UuidV7, resolution: string) =>
    await unwrapAsync(
      apiClient.api["work-items"]({ workItemId }).state.put(
        { state: "closed", reason: "completed", resolution },
        { headers: requireSetup().headers },
      ),
    );

  const childrenOf = async (parentId: UuidV7) => {
    const children = await unwrapAsync(
      apiClient.api["work-items"]({ workItemId: parentId }).children.get({
        headers: requireSetup().headers,
      }),
    );
    return new Map(children.map((child) => [String(child.id), child]));
  };

  concurrentTest(
    "derives each child's status from its state, open blockers and newest Task",
    async () => {
      const parent = await seedChild(null);
      const openBlocker = await seedChild(null);
      const names = [
        "neverRan",
        "blockedNeverRan",
        "failed",
        "blockedFailed",
        "cancelled",
        "waitingForPerson",
        "queued",
        "slotWaiting",
        "succeeded",
        "blockedSucceeded",
        "closed",
      ] as const;
      const ids = Object.fromEntries(
        await Promise.all(
          names.map(async (name) => [name, await seedChild(parent)] as const),
        ),
      ) as Record<(typeof names)[number], UuidV7>;
      for (const blocked of [
        ids.blockedNeverRan,
        ids.blockedFailed,
        ids.blockedSucceeded,
      ]) {
        await block(blocked, openBlocker);
      }
      await Promise.all([
        seedTask(ids.failed, "failed"),
        seedTask(ids.blockedFailed, "failed"),
        seedTask(ids.cancelled, "cancelled"),
        seedTask(ids.waitingForPerson, "waiting_for_person"),
        seedTask(ids.queued, "queued"),
        seedTask(ids.slotWaiting, "waiting_for_concurrency_slot"),
        seedTask(ids.succeeded, "succeeded"),
        seedTask(ids.blockedSucceeded, "succeeded"),
      ]);
      await close(ids.closed, "Done");

      const children = await childrenOf(parent);

      expect(
        Object.fromEntries(
          Object.entries(ids).map(([name, id]) => [
            name,
            children.get(String(id))?.status,
          ]),
        ),
      ).toEqual({
        neverRan: "needs_person",
        blockedNeverRan: "blocked",
        failed: "needs_person",
        blockedFailed: "needs_person",
        cancelled: "needs_person",
        waitingForPerson: "needs_person",
        queued: "running",
        slotWaiting: "running",
        succeeded: "ready",
        blockedSucceeded: "blocked",
        closed: "closed",
      });
      expect(children.get(String(ids.closed))?.resolution).toBe("Done");
    },
    30_000,
  );

  concurrentTest(
    "returns the assignee, open blockers' titles and the newest Task's step, start, question and failure",
    async () => {
      const { owner } = requireSetup();
      const step = await createStep();
      const parent = await seedChild(null);
      const blockerTitle = `Open blocker ${crypto.randomUUID()}`;
      const [running, asking, failing, blocked, openBlocker, closedBlocker] =
        await Promise.all([
          seedChild(parent, { assigneeUserId: parseUuidV7(owner.userId) }),
          seedChild(parent),
          seedChild(parent),
          seedChild(parent),
          seedChild(null, { title: blockerTitle }),
          seedChild(null),
        ]);
      await block(blocked, openBlocker);
      await block(blocked, closedBlocker);
      await close(closedBlocker, "Gone");

      await seedTask(running, "failed", {
        createdAt: new Date("2026-05-01T09:00:00.000Z"),
      });
      const runningTask = await seedTask(running, "running", {
        stepDefinitionId: step.id,
        createdAt: new Date("2026-05-01T10:00:00.000Z"),
      });
      const firstStart = new Date("2026-05-01T10:01:00.000Z");
      await seedTaskRun({
        taskId: runningTask,
        projectId: requireSetup().projectId,
        workItemId: running,
        number: 1,
        status: "failed",
        startedAt: firstStart,
        completedAt: new Date("2026-05-01T10:02:00.000Z"),
      });
      await seedTaskRun({
        taskId: runningTask,
        projectId: requireSetup().projectId,
        workItemId: running,
        number: 2,
        status: "running",
        startedAt: new Date("2026-05-01T10:03:00.000Z"),
      });
      await seedTask(asking, "waiting_for_person", {
        conversationId: await seedQuestion(
          asking,
          "Which   region\nships first?",
        ),
      });
      const failingTask = await seedTask(failing, "failed");
      await seedTaskRun({
        taskId: failingTask,
        projectId: requireSetup().projectId,
        workItemId: failing,
        number: 1,
        status: "failed",
        startedAt: firstStart,
        errorJson: { name: "Scarn.StepFailed", message: "Tests failed" },
      });

      const children = await childrenOf(parent);
      for (const child of children.values()) {
        expect(() => childWorkItemSchema.parse(child)).not.toThrow();
      }

      expect(children.get(String(running))).toMatchObject({
        status: "running",
        assignee: { userId: owner.userId },
        openBlockers: [],
        latestTask: {
          id: runningTask,
          status: "running",
          step: { key: step.key, name: "Research" },
          startedAt: firstStart.toISOString(),
          question: null,
          failure: null,
        },
      });
      expect(children.get(String(asking))).toMatchObject({
        status: "needs_person",
        assignee: null,
        latestTask: {
          step: null,
          startedAt: null,
          question: "Which region ships first?",
          failure: null,
        },
      });
      expect(children.get(String(failing))).toMatchObject({
        status: "needs_person",
        latestTask: { question: null, failure: "Tests failed" },
      });
      expect(children.get(String(blocked))).toMatchObject({
        status: "blocked",
        openBlockers: [{ id: openBlocker, title: blockerTitle }],
        latestTask: null,
      });
    },
    30_000,
  );
});

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
import { taskRuns, tasks } from "@/lib/db/schema";
import { TaskMessageEntity } from "@/tasks/task-message/domain/task-message-entity";
import { DrizzleTaskMessageRepo } from "@/tasks/task-message/infra/drizzle-task-message-repo";
import { DrizzleTaskRunHistoryReader } from "@/tasks/task-run/infra/drizzle-task-run-history-reader";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import {
  seedTaskRunParent,
  seedWorkItem,
} from "tests/lib/db/seed-task-prerequisites";

const NOW = new Date("2026-08-01T12:00:00.000Z");

describe("DrizzleTaskRunHistoryReader", () => {
  const apiClient = createScarnTreaty(
    createApp(createAppContext({ timeProvider: fixedTimeProvider(NOW) })),
  );
  const reader = new DrizzleTaskRunHistoryReader();
  const messageRepo = new DrizzleTaskMessageRepo();
  let projectId: UuidV7 | undefined;
  let ownerId: UuidV7 | undefined;

  beforeAll(async () => {
    const owner = await createTestUserAndSession({
      email: `task-history-${crypto.randomUUID()}@example.com`,
    });
    ownerId = parseUuidV7(owner.userId);
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Task History Project",
          description: "Project for task history tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    projectId = parseUuidV7(project.id);
  });

  const requireSetup = () => {
    if (!projectId || !ownerId) {
      throw new Error("Expected setup to complete");
    }
    return { projectId, ownerId };
  };

  const insertRun = async (input: {
    taskId: UuidV7;
    workItemId: UuidV7;
    number: number;
    status: "succeeded" | "failed" | "running";
    createdAt: Date;
    leaseExpiresAt?: Date;
  }): Promise<UuidV7> => {
    const id = createUuidV7();
    await getDb()
      .insert(taskRuns)
      .values({
        id,
        taskId: input.taskId,
        number: input.number,
        reason: input.number === 1 ? "initial" : "retry",
        projectId: requireSetup().projectId,
        workItemId: input.workItemId,
        status: input.status,
        leaseExpiresAt: input.leaseExpiresAt ?? null,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      });
    return id;
  };

  const seedTask = async (workItemId: UuidV7) =>
    (
      await seedTaskRunParent({
        projectId: requireSetup().projectId,
        workItemId,
      })
    ).taskId;

  const linkToPreviousTask = async (taskId: UuidV7, previousTaskId: UuidV7) =>
    await getDb()
      .update(tasks)
      .set({ previousTaskId })
      .where(eq(tasks.id, taskId));

  const sendMessage = async (taskId: UuidV7, body: string, at: Date) =>
    await messageRepo.create(
      TaskMessageEntity.create({
        taskId,
        authorUserId: requireSetup().ownerId,
        body,
        createdAt: at,
      }),
    );

  concurrentTest(
    "returns the chain oldest first, with each Task's messages on its first run",
    async () => {
      const workItemId = await seedWorkItem(requireSetup().projectId);
      const firstTask = await seedTask(workItemId);
      const secondTask = await seedTask(workItemId);
      const siblingTask = await seedTask(workItemId);
      await linkToPreviousTask(secondTask, firstTask);
      const first = await insertRun({
        taskId: firstTask,
        workItemId,
        number: 1,
        status: "succeeded",
        createdAt: new Date("2026-08-01T10:00:00.000Z"),
      });
      const retry = await insertRun({
        taskId: firstTask,
        workItemId,
        number: 2,
        status: "failed",
        createdAt: new Date("2026-08-01T10:10:00.000Z"),
      });
      const latest = await insertRun({
        taskId: secondTask,
        workItemId,
        number: 1,
        status: "running",
        createdAt: new Date("2026-08-01T10:20:00.000Z"),
        leaseExpiresAt: new Date("2026-08-01T11:00:00.000Z"),
      });
      await insertRun({
        taskId: siblingTask,
        workItemId,
        number: 1,
        status: "succeeded",
        createdAt: new Date("2026-08-01T10:30:00.000Z"),
      });
      await sendMessage(
        firstTask,
        "That timeout is a symptom.",
        new Date("2026-08-01T09:59:00.000Z"),
      );
      await sendMessage(
        secondTask,
        "Look at the cart lock.",
        new Date("2026-08-01T10:19:00.000Z"),
      );
      await sendMessage(
        secondTask,
        "And the retry loop.",
        new Date("2026-08-01T10:19:30.000Z"),
      );
      await sendMessage(
        siblingTask,
        "Not part of this chain.",
        new Date("2026-08-01T10:29:00.000Z"),
      );

      const history = await reader.loadHistory(latest, NOW);

      expect(
        history.map(
          ({ taskRunId, previousTaskRunId, status, createdAt, messages }) => ({
            taskRunId,
            previousTaskRunId,
            status,
            createdAt: createdAt.toISOString(),
            messages: messages.map(({ taskId, body }) => ({ taskId, body })),
          }),
        ),
      ).toEqual([
        {
          taskRunId: first,
          previousTaskRunId: null,
          status: "succeeded",
          createdAt: "2026-08-01T10:00:00.000Z",
          messages: [{ taskId: firstTask, body: "That timeout is a symptom." }],
        },
        {
          taskRunId: retry,
          previousTaskRunId: first,
          status: "failed",
          createdAt: "2026-08-01T10:10:00.000Z",
          messages: [],
        },
        {
          taskRunId: latest,
          previousTaskRunId: retry,
          status: "abandoned",
          createdAt: "2026-08-01T10:20:00.000Z",
          messages: [
            { taskId: secondTask, body: "Look at the cart lock." },
            { taskId: secondTask, body: "And the retry loop." },
          ],
        },
      ]);
    },
  );

  concurrentTest("returns nothing for an unknown run", async () => {
    expect(await reader.loadHistory(createUuidV7(), NOW)).toEqual([]);
  });
});

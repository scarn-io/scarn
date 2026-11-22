import { describe, expect } from "bun:test";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { TaskEntity } from "@/tasks/task/domain/task-entity";
import { DrizzleTaskRepo } from "@/tasks/task/infra/drizzle-task-repo";
import { DrizzleTaskRunRepo } from "@/tasks/task-run/infra/drizzle-task-run-repo";
import { TaskMessageEntity } from "@/tasks/task-message/domain/task-message-entity";
import { DrizzleTaskMessageRepo } from "@/tasks/task-message/infra/drizzle-task-message-repo";
import {
  agentTaskInstructionColumns,
  seedTaskPrerequisites,
} from "tests/lib/db/seed-task-prerequisites";
import { concurrentTest, fixedTimeProvider } from "tests/utils";

const NOW = new Date("2026-08-01T12:00:00.000Z");

const taskRepo = new DrizzleTaskRepo();
const taskRunRepo = new DrizzleTaskRunRepo(fixedTimeProvider(NOW));
const messageRepo = new DrizzleTaskMessageRepo();

const seedProject = async (): Promise<UuidV7> => {
  const projectId = createUuidV7();
  await getDb()
    .insert(projects)
    .values({
      id: projectId,
      name: "Task message repo test project",
      slug: `task-message-repo-${crypto.randomUUID()}`,
      gitUrl: "https://github.com/example/test-project.git",
      createdByUserId: createUuidV7(),
      orgId: createUuidV7(),
    });
  return projectId;
};

const createTask = async (
  target: { projectId: UuidV7; workItemId: UuidV7 },
  previousTaskId: UuidV7 | null = null,
) =>
  await taskRepo.create(
    TaskEntity.create({
      ...target,
      ...agentTaskInstructionColumns,
      status: "queued",
      previousTaskId,
      createdAt: NOW,
    }),
  );

describe("task previous run and messages persistence", () => {
  concurrentTest(
    "derives previousTaskRunId: the Task's run before, else the previous Task's last run",
    async () => {
      const projectId = await seedProject();
      const { workItemId } = await seedTaskPrerequisites(projectId);
      const firstTask = await createTask({ projectId, workItemId });
      const first = await taskRunRepo.create(
        firstTask.newRun({
          number: 1,
          reason: "initial",
          status: "queued",
          now: NOW,
        }),
      );
      const retry = await taskRunRepo.create(
        firstTask.newRun({
          number: 2,
          reason: "retry",
          status: "queued",
          now: NOW,
        }),
      );
      const rerun = await taskRunRepo.create(
        (await createTask({ projectId, workItemId }, firstTask.id)).newRun({
          number: 1,
          reason: "initial",
          status: "queued",
          now: NOW,
        }),
      );

      expect(first.previousTaskRunId).toBeNull();
      expect(retry.previousTaskRunId).toBe(first.id);
      expect(rerun.previousTaskRunId).toBe(retry.id);

      await taskRunRepo.save(rerun.markRunning(NOW));
      expect((await taskRunRepo.load(rerun.id))?.previousTaskRunId).toBe(
        retry.id,
      );
    },
  );

  concurrentTest(
    "creates messages and lists them for several Tasks, oldest first",
    async () => {
      const projectId = await seedProject();
      const { workItemId } = await seedTaskPrerequisites(projectId);
      const first = await createTask({ projectId, workItemId });
      const second = await createTask({ projectId, workItemId });
      const unrelated = await createTask({ projectId, workItemId });
      const authorUserId = createUuidV7();

      const later = await messageRepo.create(
        TaskMessageEntity.create({
          taskId: second.id,
          authorUserId,
          body: "  Look at the lock.  ",
          quoteText: "Reproduces 9/10 under load.",
          createdAt: new Date("2026-08-01T11:00:00.000Z"),
        }),
      );
      const earlier = await messageRepo.create(
        TaskMessageEntity.create({
          taskId: first.id,
          authorUserId,
          body: "Start with the logs.",
          createdAt: new Date("2026-08-01T10:00:00.000Z"),
        }),
      );
      await messageRepo.create(
        TaskMessageEntity.create({
          taskId: unrelated.id,
          authorUserId,
          body: "Elsewhere.",
        }),
      );

      const listed = await messageRepo.listByTaskIds([second.id, first.id]);

      expect(listed.map((message) => message.toJSON())).toEqual([
        earlier.toJSON(),
        later.toJSON(),
      ]);
      expect(later.toJSON()).toEqual({
        id: later.id,
        taskId: second.id,
        authorUserId,
        body: "Look at the lock.",
        quoteText: "Reproduces 9/10 under load.",
        createdAt: new Date("2026-08-01T11:00:00.000Z"),
      });
      expect(await messageRepo.listByTaskIds([])).toEqual([]);
    },
  );
});

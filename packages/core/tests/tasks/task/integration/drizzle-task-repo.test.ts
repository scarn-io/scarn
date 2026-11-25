import { describe, expect } from "bun:test";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { ConversationEntity } from "@/conversations/conversation/domain/conversation-entity";
import { DrizzleConversationRepo } from "@/conversations/conversation/infra/drizzle-conversation-repo";
import { getDb } from "@/lib/db";
import { projects, tasks } from "@/lib/db/schema";
import { TaskEntity } from "@/tasks/task/domain/task-entity";
import { DrizzleTaskRepo } from "@/tasks/task/infra/drizzle-task-repo";
import { DrizzleTaskRunRepo } from "@/tasks/task-run/infra/drizzle-task-run-repo";
import { expectPgError } from "tests/lib/db/orchestration-schema-test-support";
import { agentTaskInstructionColumns } from "tests/lib/db/seed-task-prerequisites";
import { concurrentTest, fixedTimeProvider } from "tests/utils";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const COMMIT = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const taskRepo = new DrizzleTaskRepo();
const taskRunRepo = new DrizzleTaskRunRepo(fixedTimeProvider(NOW));
const conversationRepo = new DrizzleConversationRepo();

const seedProject = async (): Promise<UuidV7> => {
  const projectId = createUuidV7();
  await getDb()
    .insert(projects)
    .values({
      id: projectId,
      name: "Task repo test project",
      slug: `task-repo-${crypto.randomUUID()}`,
      gitUrl: "https://github.com/example/test-project.git",
      createdByUserId: createUuidV7(),
      orgId: createUuidV7(),
    });
  return projectId;
};

const seedChatTask = async () => {
  const projectId = await seedProject();
  const conversation = await conversationRepo.create(
    ConversationEntity.start({ projectId, workItemId: null, now: NOW }),
  );
  const task = await taskRepo.create(
    TaskEntity.create({
      projectId,
      workItemId: null,
      conversationId: conversation.id,
      ...agentTaskInstructionColumns,
      status: "queued",
      createdAt: NOW,
    }),
  );
  return { projectId, conversation, task };
};

describe("DrizzleTaskRepo, a Task without a work item", () => {
  concurrentTest(
    "persists and reloads with its conversation and no work item",
    async () => {
      const { conversation, task } = await seedChatTask();

      const reloaded = await taskRepo.load(task.id);

      expect(reloaded?.workItemId).toBeNull();
      expect(reloaded?.conversationId).toBe(conversation.id);
    },
  );

  concurrentTest(
    "its runs persist and reload with no work item and their base commit",
    async () => {
      const { task } = await seedChatTask();
      const created = await taskRunRepo.create(
        task.newRun({
          number: 1,
          reason: "initial",
          status: "queued",
          baseBranch: "main",
          baseCommit: COMMIT,
          now: NOW,
        }),
      );

      const reloaded = await taskRunRepo.load(created.id);

      expect(reloaded?.workItemId).toBeNull();
      expect(reloaded?.baseBranch).toBe("main");
      expect(reloaded?.baseCommit).toBe(COMMIT);
    },
  );

  concurrentTest(
    "the database rejects a Task with no work item, conversation or schedule",
    async () => {
      const projectId = await seedProject();

      await expectPgError(
        () =>
          getDb()
            .insert(tasks)
            .values({
              id: createUuidV7(),
              projectId,
              workItemId: null,
              conversationId: null,
              ...agentTaskInstructionColumns,
              status: "queued",
              schemaVersion: 1,
            }),
        { code: "23514", constraint: "tasks_owner_check" },
      );
    },
  );
});

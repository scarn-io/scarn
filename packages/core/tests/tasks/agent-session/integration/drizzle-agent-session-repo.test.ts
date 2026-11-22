import { describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { projects, taskRuns } from "@/lib/db/schema";
import { ResourceConflictError } from "@/lib/errors";
import { AgentSessionEntity } from "@/tasks/agent-session/domain/agent-session-entity";
import { DrizzleAgentSessionRepo } from "@/tasks/agent-session/infra/drizzle-agent-session-repo";
import {
  seedTaskRunParent,
  seedTaskPrerequisites,
} from "tests/lib/db/seed-task-prerequisites";
import { concurrentTest } from "tests/utils";

const repo = new DrizzleAgentSessionRepo();

const STARTED_AT = new Date("2026-10-13T12:00:00.000Z");
const ENDED_AT = new Date("2026-10-13T12:05:00.000Z");

const seedProject = async (): Promise<UuidV7> => {
  const projectId = createUuidV7();
  await getDb()
    .insert(projects)
    .values({
      id: projectId,
      name: "Agent session repo test project",
      slug: `agent-session-repo-${crypto.randomUUID()}`,
      gitUrl: "https://github.com/example/test-project.git",
      createdByUserId: createUuidV7(),
      orgId: createUuidV7(),
    });
  return projectId;
};

const seedTask = async (projectId: UuidV7): Promise<UuidV7> => {
  const taskRunId = createUuidV7();
  const { workItemId } = await seedTaskPrerequisites(projectId);
  const parent = await seedTaskRunParent({ projectId, workItemId });
  await getDb()
    .insert(taskRuns)
    .values({
      id: taskRunId,
      projectId,
      workItemId,
      ...parent,
      status: "running",
    });
  return taskRunId;
};

const rootSession = (taskRunId: UuidV7, startedAt = STARTED_AT) =>
  AgentSessionEntity.createRoot({
    taskRunId,
    provider: "opencode",
    externalSessionId: `ses_${crypto.randomUUID()}`,
    startedAt,
  });

const rejectionOf = async (promise: Promise<object>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
};

describe("DrizzleAgentSessionRepo", () => {
  concurrentTest("creates, loads and saves a finished session", async () => {
    const taskRunId = await seedTask(await seedProject());
    const session = rootSession(taskRunId);

    const created = await repo.create(session);
    expect(created.conversationRootId).toBe(session.id);
    expect(created.status).toBe("running");

    const saved = await repo.save(created.end(ENDED_AT));
    const loaded = await repo.load(session.id);

    expect(saved.status).toBe("ended");
    expect(loaded?.toJSON()).toMatchObject({
      id: session.id,
      taskRunId,
      conversationRootId: session.id,
      parentAgentSessionId: null,
      status: "ended",
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
    });
  });

  concurrentTest("returns null for an unknown session", async () => {
    expect(await repo.load(createUuidV7())).toBeNull();
  });

  concurrentTest(
    "chains continuations across Tasks and lists sessions per Task",
    async () => {
      const projectId = await seedProject();
      const firstTaskId = await seedTask(projectId);
      const resumedTaskId = await seedTask(projectId);

      const root = await repo.create(rootSession(firstTaskId));
      const subagent = await repo.create(
        AgentSessionEntity.createRoot({
          taskRunId: firstTaskId,
          parentAgentSessionId: root.id,
          provider: "opencode",
          externalSessionId: `ses_${crypto.randomUUID()}`,
          startedAt: new Date("2026-10-13T12:01:00.000Z"),
        }),
      );
      await repo.save(root.end(ENDED_AT));
      const continuation = await repo.create(
        AgentSessionEntity.createContinuation({
          taskRunId: resumedTaskId,
          conversationRootId: root.id,
          provider: "opencode",
          externalSessionId: `ses_${crypto.randomUUID()}`,
          startedAt: new Date("2026-10-13T13:00:00.000Z"),
        }),
      );

      const firstTaskSessions = await repo.listByTaskId(firstTaskId);
      const resumedTaskSessions = await repo.listByTaskId(resumedTaskId);

      expect(firstTaskSessions.map((session) => session.id)).toEqual([
        root.id,
        subagent.id,
      ]);
      expect(subagent.parentAgentSessionId).toBe(root.id);
      expect(resumedTaskSessions.map((session) => session.id)).toEqual([
        continuation.id,
      ]);
      expect(resumedTaskSessions[0]?.conversationRootId).toBe(root.id);
    },
  );

  concurrentTest(
    "maps a duplicate (provider, externalSessionId) to a conflict",
    async () => {
      const taskRunId = await seedTask(await seedProject());
      const original = await repo.create(rootSession(taskRunId));

      const duplicate = AgentSessionEntity.createRoot({
        taskRunId,
        provider: original.provider,
        externalSessionId: original.externalSessionId,
        startedAt: STARTED_AT,
      });
      const error = await rejectionOf(repo.create(duplicate));

      expect(error).toBeInstanceOf(ResourceConflictError);
      expect((error as ResourceConflictError).code).toBe(
        "AGENT_SESSION_CONFLICT",
      );
    },
  );

  concurrentTest(
    "deleting a Task deletes its sessions and detaches later segments",
    async () => {
      const projectId = await seedProject();
      const firstTaskId = await seedTask(projectId);
      const resumedTaskId = await seedTask(projectId);

      const root = await repo.create(rootSession(firstTaskId));
      const continuation = await repo.create(
        AgentSessionEntity.createContinuation({
          taskRunId: resumedTaskId,
          conversationRootId: root.id,
          provider: "opencode",
          externalSessionId: `ses_${crypto.randomUUID()}`,
          startedAt: new Date("2026-10-13T13:00:00.000Z"),
        }),
      );

      await getDb().delete(taskRuns).where(eq(taskRuns.id, firstTaskId));

      expect(await repo.load(root.id)).toBeNull();
      expect(await repo.listByTaskId(firstTaskId)).toEqual([]);
      const survivor = await repo.load(continuation.id);
      expect(survivor?.taskRunId).toBe(resumedTaskId);
      expect(survivor?.conversationRootId).toBeNull();
    },
  );
});

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
import { concurrentTest, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";
import {
  seedPipelineStepVisit,
  seedTaskRun,
} from "./project-tasks-test-support";

const at = (minute: number) =>
  new Date(`2026-05-01T10:${String(minute).padStart(2, "0")}:00.000Z`);

/** `GET /projects/:projectId/tasks` filters, counts, and its `latest`/`durationMs`/run fields. */
describe("project Tasks list filters", () => {
  let apiClient: ReturnType<typeof createScarnTreaty>;
  let owner: Awaited<ReturnType<typeof createTestUserAndSession>> | undefined;

  beforeAll(async () => {
    apiClient = createScarnTreaty(createApp(createAppContext()));
    owner = await createTestUserAndSession({
      email: `project-tasks-filters-${crypto.randomUUID()}@example.com`,
    });
  });

  const requireOwner = () => {
    if (!owner) throw new Error("Expected setup to complete");
    return owner;
  };

  const createProject = async () =>
    parseUuidV7(
      (
        await unwrapAsync(
          apiClient.api.projects.post(
            {
              name: `Project Tasks Filters ${crypto.randomUUID()}`,
              description: "Project for the Tasks tab filters",
              gitUrl: "https://github.com/example/test-project.git",
            },
            { headers: { ...requireOwner().authHeaders } },
          ),
        )
      ).id,
    );

  const seedTask = async (input: {
    projectId: UuidV7;
    workItemId: UuidV7;
    minute: number;
    status: TaskStatus;
    kind?: "agent" | "code";
    name?: string;
    errorJson?: unknown;
    /** Opens the Task's conversation, waiting on this person as the item's assignee. */
    waitingOn?: string;
    startedByUserId?: string;
  }) => {
    const id = createUuidV7();
    const conversationId = input.waitingOn ? createUuidV7() : null;
    if (input.waitingOn && conversationId) {
      await getDb()
        .update(workItems)
        .set({ assigneeUserId: parseUuidV7(input.waitingOn) })
        .where(eq(workItems.id, input.workItemId));
      await getDb().insert(conversations).values({
        id: conversationId,
        projectId: input.projectId,
        workItemId: input.workItemId,
        status: "waiting_for_person",
      });
    }
    const code = input.kind === "code";
    await getDb()
      .insert(tasks)
      .values({
        id,
        projectId: input.projectId,
        workItemId: input.workItemId,
        kind: code ? "code" : "agent",
        name: input.name ?? null,
        prompt: code ? null : "Do the thing.",
        entrypointJson: code ? { sourceFile: "steps/lint.ts" } : null,
        status: input.status,
        errorJson: input.errorJson ?? null,
        conversationId,
        startedByUserId: input.startedByUserId
          ? parseUuidV7(input.startedByUserId)
          : null,
        createdAt: at(input.minute),
        updatedAt: at(input.minute + 30),
      });
    return { id, conversationId };
  };

  const seedProject = async () => {
    const { userId } = requireOwner();
    const projectId = await createProject();
    const [itemA, itemB] = await Promise.all([
      seedWorkItem(projectId),
      seedWorkItem(projectId),
    ]);

    const failed = await seedTask({
      projectId,
      workItemId: itemA,
      minute: 1,
      status: "failed",
      errorJson: { name: "TaskFailed", message: "Tests failed\n3 of 40" },
    });
    await seedTaskRun({
      taskId: failed.id,
      projectId,
      workItemId: itemA,
      number: 1,
      status: "failed",
      startedAt: at(1),
      completedAt: at(2),
    });
    await seedTaskRun({
      taskId: failed.id,
      projectId,
      workItemId: itemA,
      number: 2,
      status: "failed",
      startedAt: at(3),
      completedAt: new Date(at(4).getTime() + 5_000),
    });

    const code = await seedTask({
      projectId,
      workItemId: itemA,
      minute: 2,
      status: "running",
      kind: "code",
      name: "Lint",
    });
    await seedTaskRun({
      taskId: code.id,
      projectId,
      workItemId: itemA,
      number: 1,
      status: "running",
      startedAt: new Date(Date.now() - 60_000),
      logs: [
        { stream: "worker", content: "$ bun run lint" },
        { stream: "worker", content: "checked 12 files\n\n" },
        { stream: "conversation", content: "not json" },
      ],
    });
    await seedPipelineStepVisit({
      projectId,
      workItemId: itemA,
      taskId: code.id,
      name: "Ship it",
    });

    const waiting = await seedTask({
      projectId,
      workItemId: itemB,
      minute: 3,
      status: "waiting_for_person",
      waitingOn: userId,
    });
    if (waiting.conversationId) {
      await getDb()
        .insert(conversationMessages)
        .values(
          ["First question", "Which database should I use?"].map(
            (body, index) => ({
              id: createUuidV7(),
              conversationId: waiting.conversationId as UuidV7,
              authorKind: "agent" as const,
              body,
              createdAt: at(10 + index),
            }),
          ),
        );
    }

    const blocked = await seedTask({
      projectId,
      workItemId: itemB,
      minute: 4,
      status: "waiting_for_work",
    });
    return { projectId, itemA, itemB, failed, code, waiting, blocked };
  };

  const list = (projectId: UuidV7, query: Record<string, unknown> = {}) =>
    unwrapAsync(
      apiClient.api.projects({ projectId }).tasks.get({
        query,
        headers: { ...requireOwner().authHeaders },
      }),
    );

  concurrentTest(
    "filters by a status preset, kind and waitingOnMe, and counts statuses under the other filters",
    async () => {
      const seeded = await seedProject();

      const attention = await list(seeded.projectId, {
        status: ["waiting_for_person", "failed"],
      });
      expect(attention.tasks.map((task) => task.id)).toEqual([
        seeded.waiting.id,
        seeded.failed.id,
      ]);
      expect(attention.counts).toEqual({
        waiting_for_concurrency_slot: 0,
        waiting_for_work: 1,
        queued: 0,
        running: 1,
        waiting_for_person: 1,
        succeeded: 0,
        failed: 1,
        cancelled: 0,
      });

      const single = await list(seeded.projectId, { status: "failed" });
      expect(single.tasks.map((task) => task.id)).toEqual([seeded.failed.id]);

      const codeOnly = await list(seeded.projectId, { kind: "code" });
      expect(codeOnly.tasks.map((task) => task.id)).toEqual([seeded.code.id]);
      expect(codeOnly.counts.running).toBe(1);
      expect(codeOnly.counts.failed).toBe(0);

      const mine = await list(seeded.projectId, { waitingOnMe: "true" });
      expect(mine.tasks.map((task) => task.id)).toEqual([seeded.waiting.id]);
      expect(mine.counts.waiting_for_person).toBe(1);
      expect(mine.counts.failed).toBe(0);
    },
  );

  concurrentTest(
    "filters to the Tasks I started with startedByMe",
    async () => {
      const { userId } = requireOwner();
      const projectId = await createProject();
      const workItemId = await seedWorkItem(projectId);
      const mine = await seedTask({
        projectId,
        workItemId,
        minute: 1,
        status: "failed",
        startedByUserId: userId,
      });
      await seedTask({
        projectId,
        workItemId,
        minute: 2,
        status: "failed",
        startedByUserId: createUuidV7(),
      });
      await seedTask({ projectId, workItemId, minute: 3, status: "running" });

      const page = await list(projectId, { startedByMe: "true" });

      expect(page.tasks.map((task) => task.id)).toEqual([mine.id]);
      expect(page.counts.failed).toBe(1);
      expect(page.counts.running).toBe(0);
    },
  );

  concurrentTest(
    "filters by several work items and keeps each one's newest Task",
    async () => {
      const seeded = await seedProject();
      await seedProject();

      const both = await list(seeded.projectId, {
        workItemId: [seeded.itemA, seeded.itemB],
        latestPerWorkItem: "true",
      });

      expect(both.tasks.map((task) => [task.workItem?.id, task.id])).toEqual([
        [seeded.itemB, seeded.blocked.id],
        [seeded.itemA, seeded.code.id],
      ]);
    },
  );

  concurrentTest(
    "carries each Task's latest text, duration, run number and pipeline run",
    async () => {
      const seeded = await seedProject();

      const page = await list(seeded.projectId);
      const byId = new Map(page.tasks.map((task) => [task.id, task]));
      const failed = byId.get(seeded.failed.id);
      const code = byId.get(seeded.code.id);
      const waiting = byId.get(seeded.waiting.id);
      const blocked = byId.get(seeded.blocked.id);

      expect(failed?.latest).toEqual({
        kind: "error",
        text: "Tests failed 3 of 40",
      });
      expect(failed?.durationMs).toBe(3 * 60_000 + 5_000);
      expect(failed?.runNumber).toBe(2);
      expect(failed?.pipelineRun).toBeNull();

      expect(code?.latest).toEqual({ kind: "log", text: "checked 12 files" });
      expect(code?.durationMs).toBeGreaterThanOrEqual(60_000);
      expect(code?.runNumber).toBe(1);
      expect(code?.pipelineRun).toEqual({ name: "Ship it", number: 2 });
      expect(code?.source).toEqual({ kind: "code", name: "Lint" });

      expect(waiting?.latest).toEqual({
        kind: "message",
        text: "Which database should I use?",
      });
      expect(waiting?.durationMs).toBeNull();
      expect(waiting?.runNumber).toBeNull();

      expect(blocked?.latest).toBeNull();
      expect(blocked?.durationMs).toBeNull();
    },
  );

  concurrentTest(
    "a running agent's latest is its live log line, read through the conversation stream",
    async () => {
      const projectId = await createProject();
      const workItemId = await seedWorkItem(projectId);
      const agent = await seedTask({
        projectId,
        workItemId,
        minute: 1,
        status: "running",
      });
      await seedTaskRun({
        taskId: agent.id,
        projectId,
        workItemId,
        number: 1,
        status: "running",
        startedAt: new Date(),
        logs: [
          {
            stream: "conversation",
            content: JSON.stringify({
              kind: "tool",
              messageId: "m",
              partId: "p",
              callId: "c",
              tool: "bash",
              status: "completed",
              title: "Run tests",
            }),
          },
          {
            stream: "conversation",
            content: JSON.stringify({
              kind: "text",
              messageId: "m",
              partId: "p2",
              role: "user",
              text: "ignored",
            }),
          },
        ],
      });

      const page = await list(projectId);

      expect(page.tasks[0]?.latest).toEqual({
        kind: "log",
        text: "▸ Run tests",
      });
    },
  );
});

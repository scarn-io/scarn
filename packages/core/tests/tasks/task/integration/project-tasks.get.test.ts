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
  conversations,
  nodeVisits,
  pipelineGraphs,
  pipelineGraphVersions,
  pipelineRuns,
  stepDefinitions,
  taskRuns,
  tasks,
  workItems,
} from "@/lib/db/schema";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";

/** `GET /projects/:projectId/tasks` and the `GET /tasks/:taskId` header fields. */
describe("project Tasks list", () => {
  let apiClient: ReturnType<typeof createScarnTreaty>;
  let owner: Awaited<ReturnType<typeof createTestUserAndSession>> | undefined;

  const OWNER_USERNAME = `owner-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

  beforeAll(async () => {
    apiClient = createScarnTreaty(createApp(createAppContext()));
    owner = await createTestUserAndSession({
      email: `project-tasks-get-${crypto.randomUUID()}@example.com`,
      username: OWNER_USERNAME,
    });
  });

  const requireOwner = () => {
    if (!owner) {
      throw new Error("Expected setup to complete");
    }
    return owner;
  };

  const createProject = async (): Promise<ProjectContract> =>
    await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: `Project Tasks List ${crypto.randomUUID()}`,
          description: "Project for the Tasks tab",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...requireOwner().authHeaders } },
      ),
    );

  const seedTask = async (input: {
    projectId: UuidV7;
    workItemId: UuidV7;
    createdAt: Date;
    status?: "queued" | "waiting_for_person" | "succeeded";
    prompt?: string;
    stepDefinitionId?: UuidV7;
    startedByUserId?: string;
    /** Opens the Task's conversation, waiting on this person as the item's assignee. */
    waitingOn?: string;
  }): Promise<UuidV7> => {
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
    await getDb()
      .insert(tasks)
      .values({
        id,
        projectId: input.projectId,
        workItemId: input.workItemId,
        kind: "agent",
        prompt: input.prompt ?? "Do the thing.",
        stepDefinitionId: input.stepDefinitionId ?? null,
        status: input.status ?? "queued",
        startedByUserId: input.startedByUserId ?? null,
        conversationId,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      });
    return id;
  };

  const seedPipelineStepTask = async (input: {
    projectId: UuidV7;
    workItemId: UuidV7;
    createdAt: Date;
  }) => {
    const db = getDb();
    const stepDefinitionId = createUuidV7();
    const key = `tasks_list_step_${crypto.randomUUID()}`;
    await db.insert(stepDefinitions).values({
      id: stepDefinitionId,
      projectId: input.projectId,
      key,
      name: "Triage",
      prompt: "Triage it.",
      version: 3,
      kind: "user_defined",
      inputSchemaJson: { type: "object" },
      resultSchemaJson: { type: "object" },
      status: "active",
    });
    const taskId = await seedTask({ ...input, stepDefinitionId });
    const pipelineGraphId = createUuidV7();
    const pipelineGraphVersionId = createUuidV7();
    const pipelineRunId = createUuidV7();
    await db.insert(pipelineGraphs).values({
      id: pipelineGraphId,
      projectId: input.projectId,
      key: `tasks_list_graph_${crypto.randomUUID()}`,
      name: "Tasks list graph",
    });
    await db.insert(pipelineGraphVersions).values({
      id: pipelineGraphVersionId,
      pipelineGraphId,
      version: 1,
      definitionJson: {},
      schemaVersion: 1,
      contentHash: crypto.randomUUID(),
    });
    await db.insert(pipelineRuns).values({
      id: pipelineRunId,
      projectId: input.projectId,
      workItemId: input.workItemId,
      pipelineGraphId,
      pipelineGraphVersionId,
      status: "active",
    });
    await db.insert(nodeVisits).values({
      id: createUuidV7(),
      pipelineRunId,
      nodeId: "triage",
      nodeKind: "step",
      transitionJson: {},
      status: "active",
      inputJson: {},
      taskId,
      createdAt: input.createdAt,
    });
    return { taskId, stepDefinitionId, key, pipelineRunId };
  };

  const seedProjectWithTasks = async () => {
    const { userId } = requireOwner();
    const project = await createProject();
    const projectId = parseUuidV7(project.id);
    const [itemA, itemB] = await Promise.all([
      seedWorkItem(projectId),
      seedWorkItem(projectId),
    ]);
    const oldest = await seedTask({
      projectId,
      workItemId: itemA,
      createdAt: new Date("2026-05-01T10:00:00.000Z"),
      prompt: "x".repeat(300),
      startedByUserId: userId,
    });
    const pipeline = await seedPipelineStepTask({
      projectId,
      workItemId: itemB,
      createdAt: new Date("2026-05-01T11:00:00.000Z"),
    });
    const newest = await seedTask({
      projectId,
      workItemId: itemA,
      createdAt: new Date("2026-05-01T12:00:00.000Z"),
      status: "waiting_for_person",
      waitingOn: userId,
    });
    return { projectId, itemA, itemB, oldest, pipeline, newest };
  };

  const list = (
    projectId: UuidV7,
    query: Record<string, string> = {},
    headers = requireOwner().authHeaders,
  ) =>
    apiClient.api
      .projects({ projectId })
      .tasks.get({ query, headers: { ...headers } });

  concurrentTest(
    "lists standalone and pipeline step Tasks newest first",
    async () => {
      const { userId } = requireOwner();
      const seeded = await seedProjectWithTasks();
      await seedProjectWithTasks();

      const page = await unwrapAsync(list(seeded.projectId));

      expect(page.nextCursor).toBeNull();
      expect(page.tasks.map((task) => task.id)).toEqual([
        seeded.newest,
        seeded.pipeline.taskId,
        seeded.oldest,
      ]);
      const [newest, pipeline, oldest] = page.tasks;
      expect(newest?.waitingOnYou).toBe(true);
      expect(newest?.waitingOn).toEqual([
        { userId: parseUuidV7(userId), username: OWNER_USERNAME },
      ]);
      expect(newest?.conversationId).not.toBeNull();
      expect(newest?.pipelineRunId).toBeNull();
      expect(newest?.startedBy).toEqual({ kind: "system" });
      expect(newest?.source).toEqual({
        kind: "prompt",
        promptPreview: "Do the thing.",
      });
      expect(pipeline?.waitingOnYou).toBe(false);
      expect(pipeline?.waitingOn).toEqual([]);
      expect(pipeline?.conversationId).toBeNull();
      expect(pipeline?.pipelineRunId).toBe(seeded.pipeline.pipelineRunId);
      expect(pipeline?.nodeId).toBe("triage");
      expect(pipeline?.workItem?.id).toBe(seeded.itemB);
      expect(pipeline?.source).toEqual({
        kind: "step_definition",
        stepDefinitionId: seeded.pipeline.stepDefinitionId,
        key: seeded.pipeline.key,
        name: "Triage",
        version: 3,
      });
      expect(oldest?.startedBy).toMatchObject({
        kind: "user",
        userId: parseUuidV7(userId),
      });
      expect(oldest?.source.kind).toBe("prompt");
      if (oldest?.source.kind === "prompt") {
        expect(oldest.source.promptPreview.length).toBe(120);
      }
    },
  );

  concurrentTest("filters by status and work item, and pages", async () => {
    const seeded = await seedProjectWithTasks();

    const waiting = await unwrapAsync(
      list(seeded.projectId, { status: "waiting_for_person" }),
    );
    expect(waiting.tasks.map((task) => task.id)).toEqual([seeded.newest]);

    const forItemA = await unwrapAsync(
      list(seeded.projectId, { workItemId: seeded.itemA }),
    );
    expect(forItemA.tasks.map((task) => task.id)).toEqual([
      seeded.newest,
      seeded.oldest,
    ]);

    const first = await unwrapAsync(list(seeded.projectId, { limit: "2" }));
    expect(first.tasks.map((task) => task.id)).toEqual([
      seeded.newest,
      seeded.pipeline.taskId,
    ]);
    expect(first.nextCursor).toBe(seeded.pipeline.taskId);
    const second = await unwrapAsync(
      list(seeded.projectId, {
        limit: "2",
        before: seeded.pipeline.taskId,
      }),
    );
    expect(second.tasks.map((task) => task.id)).toEqual([seeded.oldest]);
    expect(second.nextCursor).toBeNull();
  });

  concurrentTest(
    "a Task waits on you only when its conversation waits on you",
    async () => {
      const seeded = await seedProjectWithTasks();
      const member = await createTestUserAndSession({
        email: `project-tasks-get-member-${crypto.randomUUID()}@example.com`,
      });
      await unwrapAsync(
        apiClient.api
          .projects({ projectId: seeded.projectId })
          .members({ userId: member.userId })
          .role.put(
            { role: "read" },
            { headers: { ...requireOwner().authHeaders } },
          ),
      );

      const ownerView = await unwrapAsync(
        apiClient.api
          .tasks({ taskId: seeded.newest })
          .get({ headers: { ...requireOwner().authHeaders } }),
      );
      const memberView = await unwrapAsync(
        apiClient.api
          .tasks({ taskId: seeded.newest })
          .get({ headers: { ...member.authHeaders } }),
      );
      const memberPage = await unwrapAsync(
        list(seeded.projectId, {}, member.authHeaders),
      );

      expect(ownerView.waitingOnYou).toBe(true);
      expect(memberView.waitingOnYou).toBe(false);
      expect(memberView.waitingOn).toEqual(ownerView.waitingOn);
      expect(memberView.conversationId).toBe(ownerView.conversationId);
      expect(memberPage.tasks.map((task) => task.waitingOnYou)).toEqual([
        false,
        false,
        false,
      ]);
    },
  );

  concurrentTest(
    "a running Task whose run's lease lapsed reads as failed",
    async () => {
      const project = await createProject();
      const projectId = parseUuidV7(project.id);
      const workItemId = await seedWorkItem(projectId);
      const createdAt = new Date(Date.now() - 60 * 60_000);
      const seedRunningTask = async (leaseExpiresAt: Date) => {
        const taskId = createUuidV7();
        await getDb().insert(tasks).values({
          id: taskId,
          projectId,
          workItemId,
          kind: "agent",
          prompt: "Do the thing.",
          status: "running",
          createdAt,
          updatedAt: createdAt,
        });
        await getDb().insert(taskRuns).values({
          id: createUuidV7(),
          taskId,
          number: 1,
          reason: "initial",
          projectId,
          workItemId,
          status: "running",
          claimedBy: "gone-worker",
          claimToken: crypto.randomUUID(),
          claimedAt: createdAt,
          startedAt: createdAt,
          leaseExpiresAt,
          createdAt,
          updatedAt: createdAt,
        });
        return taskId;
      };
      const lapsed = await seedRunningTask(new Date(Date.now() - 30 * 60_000));
      const live = await seedRunningTask(new Date(Date.now() + 30 * 60_000));

      const page = await unwrapAsync(list(projectId));
      const byId = new Map(page.tasks.map((task) => [task.id, task]));
      expect(byId.get(lapsed)?.status).toBe("failed");
      expect(byId.get(lapsed)?.latest).toEqual({
        kind: "error",
        text: "The step stopped sending heartbeats",
      });
      expect(byId.get(live)?.status).toBe("running");
      expect(page.counts.running).toBe(1);
      expect(page.counts.failed).toBe(1);

      const running = await unwrapAsync(list(projectId, { status: "running" }));
      expect(running.tasks.map((task) => task.id)).toEqual([live]);

      const detail = await unwrapAsync(
        apiClient.api
          .tasks({ taskId: lapsed })
          .get({ headers: { ...requireOwner().authHeaders } }),
      );
      expect(detail.status).toBe("failed");
    },
  );

  concurrentTest("rejects a caller outside the project", async () => {
    const seeded = await seedProjectWithTasks();
    const outsider = await createTestUserAndSession({
      email: `project-tasks-get-outsider-${crypto.randomUUID()}@example.com`,
    });

    const { data, error } = await list(
      seeded.projectId,
      {},
      outsider.authHeaders,
    );

    expect(data).toBeNull();
    expect(error?.status).toBe(403);
  });

  concurrentTest("GET /tasks/:taskId carries the view header", async () => {
    const seeded = await seedProjectWithTasks();

    const task = await unwrapAsync(
      apiClient.api
        .tasks({ taskId: seeded.pipeline.taskId })
        .get({ headers: { ...requireOwner().authHeaders } }),
    );

    expect(task.status).toBe("queued");
    expect(task.workItemId).toBe(seeded.itemB);
    expect(task.workItem?.id).toBe(seeded.itemB);
    expect(task.pipelineRunId).toBe(seeded.pipeline.pipelineRunId);
    expect(task.source.kind).toBe("step_definition");
    expect(task.startedBy).toEqual({ kind: "system" });
  });
});

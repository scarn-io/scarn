import { beforeAll, describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";

/**
 * A Task started on a blocked work item waits with no run, and gets its
 * `initial` run once a person's close or a removed block leaves the item with
 * no open blockers.
 */
describe("tasks waiting for work", () => {
  let apiClient: ReturnType<typeof createScarnTreaty>;
  let project: ProjectContract | undefined;
  let authHeaders: { authorization: string } | undefined;
  let stepDefinition: { id: UuidV7; version: number } | undefined;

  beforeAll(async () => {
    apiClient = createScarnTreaty(
      createApp(
        createAppContext({
          timeProvider: fixedTimeProvider(new Date("2026-05-01T12:00:00.000Z")),
        }),
      ),
    );
    const owner = await createTestUserAndSession({
      email: `task-waiting-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Task Waiting Project",
          description: "Project for waiting-for-work tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    const created = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        {
          projectId: parseUuidV7(project.id),
          key: `task_waiting_${crypto.randomUUID()}`,
          name: "Waiting step",
          description: "Step for waiting-for-work tests",
          prompt: "Return a result payload.",
          version: 1,
          kind: "user_defined",
          inputSchemaJson: { type: "object" },
          resultSchemaJson: { type: "object" },
          status: "active",
          repo: { mode: "readOnly" },
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    stepDefinition = { id: parseUuidV7(created.id), version: created.version };
  });

  const requireSetup = () => {
    if (!project || !authHeaders || !stepDefinition) {
      throw new Error("Expected setup to complete");
    }
    return {
      projectId: parseUuidV7(project.id),
      headers: { ...authHeaders },
      stepDefinition,
    };
  };

  const block = async (blockedWorkItemId: UuidV7, blockingWorkItemId: UuidV7) =>
    await unwrapAsync(
      apiClient.api["work-item-blocks"].post(
        {
          blockedWorkItemId: parseWorkItemId(blockedWorkItemId),
          blockingWorkItemId: parseWorkItemId(blockingWorkItemId),
        },
        { headers: requireSetup().headers },
      ),
    );

  const setState = async (workItemId: UuidV7, state: "open" | "closed") =>
    await unwrapAsync(
      apiClient.api["work-items"]({ workItemId }).state.put(
        state === "closed"
          ? { state: "closed", reason: "completed" }
          : { state: "open" },
        { headers: requireSetup().headers },
      ),
    );

  const startTask = async (workItemId: UuidV7) => {
    const { projectId, headers, stepDefinition } = requireSetup();
    return await unwrapAsync(
      apiClient.api.tasks.post(
        {
          projectId,
          workItemId,
          stepDefinitionId: stepDefinition.id,
          stepDefinitionVersion: stepDefinition.version,
          inputJson: null,
        },
        { headers },
      ),
    );
  };

  const loadTask = async (taskId: string) => {
    const { headers } = requireSetup();
    const [task, runs] = await Promise.all([
      unwrapAsync(apiClient.api.tasks({ taskId }).get({ headers })),
      unwrapAsync(apiClient.api.tasks({ taskId }).runs.get({ headers })),
    ]);
    return { task, runs };
  };

  const expectStillWaiting = async (taskId: string) => {
    const { task, runs } = await loadTask(taskId);
    expect(task.status).toBe("waiting_for_work");
    expect(runs).toEqual([]);
  };

  const expectStarted = async (taskId: string) => {
    const { task, runs } = await loadTask(taskId);
    expect(task.status).toBe("queued");
    expect(
      runs.map(({ number, reason, status }) => ({ number, reason, status })),
    ).toEqual([{ number: 1, reason: "initial", status: "queued" }]);
  };

  const seedBlockedItem = async () => {
    const { projectId } = requireSetup();
    const blocked = await seedWorkItem(projectId);
    const blocker = await seedWorkItem(projectId);
    const created = await block(blocked, blocker);
    return { blocked, blocker, blockId: created.id };
  };

  concurrentTest(
    "POST /tasks on a blocked item creates a waiting Task with no run",
    async () => {
      const { blocked } = await seedBlockedItem();

      const created = await startTask(blocked);

      expect(created.task.status).toBe("waiting_for_work");
      expect(created.run).toBeNull();
      await expectStillWaiting(created.task.id);
    },
  );

  concurrentTest(
    "POST /tasks on an item whose only blocker is closed starts at once",
    async () => {
      const { blocked, blocker } = await seedBlockedItem();
      await setState(blocker, "closed");

      const created = await startTask(blocked);

      expect(created.task.status).toBe("queued");
      expect(created.run).toMatchObject({ number: 1, reason: "initial" });
    },
  );

  concurrentTest(
    "a person closing the last blocker gives the waiting Task its run",
    async () => {
      const { blocked, blocker } = await seedBlockedItem();
      const { task } = await startTask(blocked);

      await setState(blocker, "closed");

      await expectStarted(task.id);
    },
  );

  concurrentTest(
    "removing the last block gives the waiting Task its run",
    async () => {
      const { blocked, blockId } = await seedBlockedItem();
      const { task } = await startTask(blocked);

      await unwrapAsync(
        apiClient.api["work-item-blocks"]({ blockId }).delete(undefined, {
          headers: requireSetup().headers,
        }),
      );

      await expectStarted(task.id);
    },
  );

  concurrentTest(
    "adding a block runs nothing, and closing one of two blockers runs nothing",
    async () => {
      const { projectId } = requireSetup();
      const { blocked, blocker } = await seedBlockedItem();
      const { task } = await startTask(blocked);
      const secondBlocker = await seedWorkItem(projectId);

      await block(blocked, secondBlocker);
      await expectStillWaiting(task.id);

      await setState(blocker, "closed");
      await expectStillWaiting(task.id);

      await setState(secondBlocker, "closed");
      await expectStarted(task.id);
    },
  );

  concurrentTest("reopening a blocker starts nothing", async () => {
    const { projectId } = requireSetup();
    const { blocked, blocker } = await seedBlockedItem();
    const secondBlocker = await seedWorkItem(projectId);
    await block(blocked, secondBlocker);
    await setState(blocker, "closed");
    const { task } = await startTask(blocked);

    await setState(blocker, "open");

    await expectStillWaiting(task.id);
  });
});

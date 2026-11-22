import { beforeAll, describe, expect } from "bun:test";
import { and, eq } from "drizzle-orm";
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
  tasks,
  workItemBlocks,
  workItemComments,
  workItems,
} from "@/lib/db/schema";
import type { ObjectStore } from "@/artifacts/object-store";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import type { WorkItemChange } from "@/tasks/task/contracts/work-item-change-contracts";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { allGrants } from "tests/tasks/task/grants-test-support";

const failingObjectStore = {
  putObject: () => Promise.reject(new Error("object store down")),
} as unknown as ObjectStore;

/**
 * An agent Task's work item changes ride on its run's completion: applied in
 * the completion transaction when the run succeeded and its log was kept,
 * and refused whole (the run failing with a named error) otherwise.
 */
describe("work item changes on run completion", () => {
  const buildClient = (objectStore: ObjectStore | null) =>
    createScarnTreaty(
      createApp(
        createAppContext({
          timeProvider: fixedTimeProvider(new Date("2026-10-29T12:00:00.000Z")),
          objectStore,
        }),
      ),
    );
  const apiClient = buildClient(null);
  const failingArchiveClient = buildClient(failingObjectStore);
  let project: ProjectContract | undefined;
  let headers: { authorization: string } | undefined;
  let wayfinderStep: { id: UuidV7; version: number } | undefined;
  let planStep: { id: UuidV7; version: number; key: string } | undefined;

  beforeAll(async () => {
    const owner = await createTestUserAndSession({
      email: `work-item-changes-${crypto.randomUUID()}@example.com`,
    });
    headers = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Work Item Changes Project",
          description: "Project for agent work item change tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    const createStep = async (key: string, children: boolean) =>
      await unwrapAsync(
        apiClient.api["step-definitions"].post(
          {
            projectId: parseUuidV7(project?.id ?? ""),
            key,
            name: key,
            description: "Step for work item change tests",
            prompt: "Do the work.",
            version: 1,
            kind: "user_defined",
            inputSchemaJson: { type: "object" },
            resultSchemaJson: { type: "object" },
            status: "active",
            repo: { mode: "readOnly" },
            grants: children
              ? [...allGrants("self", ["a"]), ...allGrants("children", ["a"])]
              : [],
          },
          { headers: { ...owner.authHeaders } },
        ),
      );
    const wayfinder = await createStep(
      `wayfinder_${crypto.randomUUID()}`,
      true,
    );
    wayfinderStep = {
      id: parseUuidV7(wayfinder.id),
      version: wayfinder.version,
    };
    const plan = await createStep(`plan_${crypto.randomUUID()}`, false);
    planStep = {
      id: parseUuidV7(plan.id),
      version: plan.version,
      key: plan.key,
    };
  });

  const requireSetup = () => {
    if (!project || !headers || !wayfinderStep || !planStep) {
      throw new Error("Expected setup to complete");
    }
    return {
      projectId: parseUuidV7(project.id),
      headers: { ...headers },
      wayfinderStep,
      planStep,
    };
  };

  const seedNativeItem = async (parent: UuidV7 | null = null) => {
    const id = createUuidV7();
    await getDb()
      .insert(workItems)
      .values({
        id,
        projectId: requireSetup().projectId,
        platform: "scarn",
        platformKey: `manual-${id}`,
        title: `Item ${id}`,
        description: "Original",
        parentWorkItemId: parent,
      });
    return id;
  };

  const startTask = async (
    workItemId: UuidV7,
    step: { id: UuidV7; version: number },
  ) => {
    const { projectId, headers } = requireSetup();
    return await unwrapAsync(
      apiClient.api.tasks.post(
        {
          projectId,
          workItemId,
          stepDefinitionId: step.id,
          stepDefinitionVersion: step.version,
          inputJson: null,
        },
        { headers },
      ),
    );
  };

  const runWayfinder = async (
    workItemId: UuidV7,
    workItemChanges: WorkItemChange[],
    client = apiClient,
  ) => {
    const { projectId, headers, wayfinderStep } = requireSetup();
    const started = await startTask(workItemId, wayfinderStep);
    const taskRunId = started.run?.id;
    if (!taskRunId) {
      throw new Error("Expected the Task to start with a run");
    }
    const claims = await unwrapAsync(
      client.api["task-runs"].claims.post(
        {
          projectId,
          workItemId,
          workerId: `work-item-changes-${crypto.randomUUID()}`,
          batchSize: 1,
          leaseDurationSeconds: 30,
        },
        { headers },
      ),
    );
    const claimToken = claims.find(
      (claim) => claim.task.id === taskRunId,
    )?.claimToken;
    if (!claimToken) {
      throw new Error("Expected to claim the run");
    }
    const run = await unwrapAsync(
      client.api["task-runs"]({ taskRunId }).completions.post(
        {
          claimToken,
          status: "succeeded",
          resultJson: { done: true },
          errorJson: null,
          workItemChanges,
        },
        { headers },
      ),
    );
    return { taskId: started.task.id, run };
  };

  const loadItem = async (id: UuidV7) =>
    (await getDb().select().from(workItems).where(eq(workItems.id, id)))[0];

  const blocksOf = async (blockedWorkItemId: UuidV7) =>
    await getDb()
      .select()
      .from(workItemBlocks)
      .where(eq(workItemBlocks.blockedWorkItemId, blockedWorkItemId));

  concurrentTest("applies a block in the completion", async () => {
    const root = await seedNativeItem();
    const first = await seedNativeItem(root);
    const second = await seedNativeItem(root);

    const { run } = await runWayfinder(root, [
      { kind: "block", blockedWorkItemId: second, blockingWorkItemId: first },
    ]);

    expect(run.status).toBe("succeeded");
    expect(
      (await blocksOf(second)).map((block) => block.blockingWorkItemId),
    ).toEqual([first]);
  });

  concurrentTest(
    "describes, comments on and closes with the closing Task recorded",
    async () => {
      const root = await seedNativeItem();
      const child = await seedNativeItem(root);

      const { taskId, run } = await runWayfinder(root, [
        {
          kind: "describe",
          workItemId: child,
          description: "Sharper",
          descriptionVersion: 1,
        },
        { kind: "comment", workItemId: child, body: "Looked at it" },
        {
          kind: "close",
          workItemId: child,
          reason: "completed",
          resolution: "Done here",
        },
      ]);

      expect(run.status).toBe("succeeded");
      expect(await loadItem(child)).toMatchObject({
        description: "Sharper",
        descriptionVersion: 2,
        state: "closed",
        closedByTaskId: taskId,
        closedByUserId: null,
      });
      const comments = await getDb()
        .select()
        .from(workItemComments)
        .where(eq(workItemComments.workItemId, child));
      expect(comments.map((comment) => comment.body).sort()).toEqual([
        "Done here",
        "Looked at it",
      ]);
    },
  );

  concurrentTest(
    "an invalid change fails the run and applies nothing",
    async () => {
      const root = await seedNativeItem();
      const other = await seedNativeItem();

      const { run } = await runWayfinder(root, [
        {
          kind: "describe",
          workItemId: root,
          description: "Sharper",
          descriptionVersion: 1,
        },
        { kind: "close", workItemId: other, reason: "completed" },
      ]);

      expect(run.status).toBe("failed");
      expect(run.errorJson).toMatchObject({
        name: "Scarn.WorkItemChangesInvalid",
      });
      expect(run.resultJson).toBeNull();
      expect((await loadItem(root))?.description).toBe("Original");
      expect((await loadItem(other))?.state).toBe("open");
    },
  );

  concurrentTest(
    "a change to a synced item fails the run as not native",
    async () => {
      const root = await seedNativeItem();
      await getDb()
        .update(workItems)
        .set({ platform: "github", platformKey: `#${root}` })
        .where(eq(workItems.id, root));

      const { run } = await runWayfinder(root, [
        { kind: "comment", workItemId: root, body: "Hi" },
      ]);

      expect(run.status).toBe("failed");
      expect(run.errorJson).toMatchObject({ name: "Scarn.WorkItemNotNative" });
    },
  );

  concurrentTest(
    "a log archive that isn't written fails the run and applies nothing",
    async () => {
      const root = await seedNativeItem();

      const { run } = await runWayfinder(
        root,
        [
          {
            kind: "describe",
            workItemId: root,
            description: "Sharper",
            descriptionVersion: 1,
          },
        ],
        failingArchiveClient,
      );

      expect(run.status).toBe("failed");
      expect(run.errorJson).toMatchObject({ name: "Scarn.LogArchiveFailed" });
      expect((await loadItem(root))?.description).toBe("Original");
    },
  );

  concurrentTest(
    "an agent's close of a blocker starts the Task waiting on the dependent item",
    async () => {
      const { headers, planStep } = requireSetup();
      const root = await seedNativeItem();
      const blocker = await seedNativeItem(root);
      const dependent = await seedNativeItem(root);
      await unwrapAsync(
        apiClient.api["work-item-blocks"].post(
          {
            blockedWorkItemId: parseWorkItemId(dependent),
            blockingWorkItemId: parseWorkItemId(blocker),
          },
          { headers },
        ),
      );
      const waiting = await startTask(dependent, planStep);
      expect(waiting.task.status).toBe("waiting_for_work");

      const { run } = await runWayfinder(root, [
        { kind: "close", workItemId: blocker, reason: "completed" },
      ]);

      expect(run.status).toBe("succeeded");
      const [task] = await getDb()
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, waiting.task.id)));
      expect(task?.status).toBe("queued");
    },
  );
});

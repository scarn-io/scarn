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
import { workItems } from "@/lib/db/schema";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import type { WorkItemChange } from "@/tasks/task/contracts/work-item-change-contracts";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { grant } from "tests/tasks/task/grants-test-support";

/**
 * Labels in an agent Task's work item changes: `label` changes add and remove
 * labels on native items, applied with the rest of the run's changes.
 */
describe("work item label changes on run completion", () => {
  const apiClient = createScarnTreaty(
    createApp(
      createAppContext({
        timeProvider: fixedTimeProvider(new Date("2026-10-29T12:00:00.000Z")),
      }),
    ),
  );
  let project: ProjectContract | undefined;
  let headers: { authorization: string } | undefined;
  let wayfinderStep: { id: UuidV7; version: number } | undefined;

  beforeAll(async () => {
    const owner = await createTestUserAndSession({
      email: `work-item-label-changes-${crypto.randomUUID()}@example.com`,
    });
    headers = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Work Item Label Changes Project",
          description: "Project for agent label change tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    const step = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        {
          projectId: parseUuidV7(project.id),
          key: `wayfinder_${crypto.randomUUID()}`,
          name: "wayfinder",
          description: "Step for label change tests",
          prompt: "Do the work.",
          version: 1,
          kind: "user_defined",
          inputSchemaJson: { type: "object" },
          resultSchemaJson: { type: "object" },
          status: "active",
          repo: { mode: "readOnly" },
          grants: [
            grant("label", "self", ["bug"]),
            grant("label", "children", ["old", "wayfinder:task", "Urgent"]),
          ],
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    wayfinderStep = { id: parseUuidV7(step.id), version: step.version };
  });

  const requireSetup = () => {
    if (!project || !headers || !wayfinderStep) {
      throw new Error("Expected setup to complete");
    }
    return {
      projectId: parseUuidV7(project.id),
      headers: { ...headers },
      wayfinderStep,
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

  const runWayfinder = async (
    workItemId: UuidV7,
    workItemChanges: WorkItemChange[],
  ) => {
    const { projectId, headers, wayfinderStep } = requireSetup();
    const started = await unwrapAsync(
      apiClient.api.tasks.post(
        {
          projectId,
          workItemId,
          stepDefinitionId: wayfinderStep.id,
          stepDefinitionVersion: wayfinderStep.version,
          inputJson: null,
        },
        { headers },
      ),
    );
    const taskRunId = started.run?.id;
    if (!taskRunId) {
      throw new Error("Expected the Task to start with a run");
    }
    const claims = await unwrapAsync(
      apiClient.api["task-runs"].claims.post(
        {
          projectId,
          workItemId,
          workerId: `work-item-label-changes-${crypto.randomUUID()}`,
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
      apiClient.api["task-runs"]({ taskRunId }).completions.post(
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
    return { run };
  };

  const loadItem = async (id: UuidV7) =>
    (await getDb().select().from(workItems).where(eq(workItems.id, id)))[0];

  concurrentTest("applies label changes with the run's changes", async () => {
    const root = await seedNativeItem();
    const child = await seedNativeItem(root);
    await getDb()
      .update(workItems)
      .set({ labels: ["old", "keep"] })
      .where(eq(workItems.id, child));

    const { run } = await runWayfinder(root, [
      {
        kind: "label",
        workItemId: child,
        add: ["wayfinder:task"],
        remove: ["old"],
      },
      { kind: "label", workItemId: child, add: ["Urgent"] },
    ]);

    expect(run.status).toBe("succeeded");
    expect((await loadItem(child))?.labels).toEqual([
      "keep",
      "wayfinder:task",
      "Urgent",
    ]);
  });

  concurrentTest(
    "a label change on a synced item fails the run as not native",
    async () => {
      const root = await seedNativeItem();
      await getDb()
        .update(workItems)
        .set({ platform: "github", platformKey: `#${root}` })
        .where(eq(workItems.id, root));

      const { run } = await runWayfinder(root, [
        { kind: "label", workItemId: root, add: ["bug"] },
      ]);

      expect(run.status).toBe("failed");
      expect(run.errorJson).toMatchObject({ name: "Scarn.WorkItemNotNative" });
      expect((await loadItem(root))?.labels).toEqual([]);
    },
  );
});

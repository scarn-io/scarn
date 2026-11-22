import { beforeAll, describe, expect } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createApp } from "@scarn/api/app";
import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import { getDb } from "@/lib/db";
import type { DbExecutor } from "@/lib/db/db-executor";
import { workItemComments, workItems } from "@/lib/db/schema";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import type { WorkItemChange } from "@/tasks/task/contracts/work-item-change-contracts";
import type { WorkItemEntity } from "@/work-items/work-item/domain/work-item-entity";
import { DrizzleWorkItemRepo } from "@/work-items/work-item/infra/drizzle-work-item-repo";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { grant } from "tests/tasks/task/grants-test-support";

/**
 * Lands a person's description write on the row just before the agent's
 * conditional write, after the run's changes were validated: the race the
 * early check in `validateWorkItemChanges` can't see.
 */
class RacedWorkItemRepo extends DrizzleWorkItemRepo {
  readonly raced = new Set<string>();

  override async saveDescription(
    workItem: WorkItemEntity,
    expectedVersion: number,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemEntity> {
    if (this.raced.has(workItem.id)) {
      await (dbExecutor ?? getDb())
        .update(workItems)
        .set({
          description: "A person's edit",
          descriptionVersion: sql`${workItems.descriptionVersion} + 1`,
        })
        .where(eq(workItems.id, workItem.id));
    }
    return await super.saveDescription(workItem, expectedVersion, dbExecutor);
  }
}

/**
 * An agent's description write is a compare-and-set on the version it read:
 * one that lands after someone else's write is refused, and the run's other
 * changes roll back with it.
 */
describe("work item description conflicts on run completion", () => {
  const workItemRepo = new RacedWorkItemRepo();
  const apiClient = createScarnTreaty(
    createApp(
      createAppContext({
        timeProvider: fixedTimeProvider(new Date("2026-10-29T12:00:00.000Z")),
        workItemRepo,
      }),
    ),
  );
  let project: ProjectContract | undefined;
  let headers: { authorization: string } | undefined;
  let wayfinderStep: { id: UuidV7; version: number } | undefined;

  beforeAll(async () => {
    const owner = await createTestUserAndSession({
      email: `work-item-description-conflicts-${crypto.randomUUID()}@example.com`,
    });
    headers = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Work Item Description Conflicts Project",
          description: "Project for description conflict tests",
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
          description: "Step for description conflict tests",
          prompt: "Do the work.",
          version: 1,
          kind: "user_defined",
          inputSchemaJson: { type: "object" },
          resultSchemaJson: { type: "object" },
          status: "active",
          repo: { mode: "readOnly" },
          grants: [
            grant("update", "self"),
            grant("comment", "self"),
            grant("label", "self", ["wayfinder:map"]),
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

  const createNativeItem = async () => {
    const { projectId, headers } = requireSetup();
    const created = await unwrapAsync(
      apiClient.api["work-items"].post(
        {
          projectId,
          platform: "scarn",
          platformId: null,
          platformKey: `manual-${createUuidV7()}`,
          url: null,
          title: "Map",
          description: "Original",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          fields: null,
        },
        { headers },
      ),
    );
    return parseUuidV7(created.id);
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
          workerId: `work-item-description-conflicts-${crypto.randomUUID()}`,
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
    return await unwrapAsync(
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
  };

  const loadItem = async (id: UuidV7) =>
    (await getDb().select().from(workItems).where(eq(workItems.id, id)))[0];

  const commentsOn = async (workItemId: UuidV7) =>
    await getDb()
      .select()
      .from(workItemComments)
      .where(eq(workItemComments.workItemId, workItemId));

  const agentChanges = (root: UuidV7): WorkItemChange[] => [
    { kind: "label", workItemId: root, add: ["wayfinder:map"] },
    { kind: "comment", workItemId: root, body: "Replanned" },
    {
      kind: "describe",
      workItemId: root,
      description: "The agent's plan",
      descriptionVersion: 1,
    },
  ];

  concurrentTest(
    "an agent write after a person's edit is refused and the run's other changes roll back",
    async () => {
      const root = await createNativeItem();
      await unwrapAsync(
        apiClient.api["work-items"]({ workItemId: root }).patch(
          { description: "A person's edit", descriptionVersion: 1 },
          { headers: requireSetup().headers },
        ),
      );

      const run = await runWayfinder(root, agentChanges(root));

      expect(run.status).toBe("failed");
      expect(run.errorJson).toMatchObject({
        name: "Scarn.WorkItemChangesInvalid",
      });
      expect(JSON.stringify(run.errorJson)).toContain("read it again");
      expect(await loadItem(root)).toMatchObject({
        description: "A person's edit",
        descriptionVersion: 2,
        labels: [],
      });
      expect(await commentsOn(root)).toEqual([]);
    },
  );

  concurrentTest(
    "a person's edit landing after validation still refuses the agent write as one transaction",
    async () => {
      const root = await createNativeItem();
      workItemRepo.raced.add(root);

      const run = await runWayfinder(root, agentChanges(root));

      expect(run.status).toBe("failed");
      expect(run.errorJson).toMatchObject({
        name: "Scarn.WorkItemChangesInvalid",
      });
      expect(JSON.stringify(run.errorJson)).toContain("read it again");
      expect(await loadItem(root)).toMatchObject({
        description: "Original",
        descriptionVersion: 1,
        labels: [],
      });
      expect(await commentsOn(root)).toEqual([]);
    },
  );
});

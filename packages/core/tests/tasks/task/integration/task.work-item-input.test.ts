import { beforeAll, describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "@scarn/api/app";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import { getDb } from "@/lib/db";
import { workItems } from "@/lib/db/schema";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";
import {
  createPipelineFromDocument,
  latestTaskIdForNode,
  singleStepPipelineDocument,
} from "tests/pipeline-definitions/pipeline-test-support";

/**
 * No Task's input carries its work item: step args still resolve into it,
 * and the agent reads the item live (`task.work-item-read.test.ts`).
 * `POST /tasks` also starts a Task from a bare prompt.
 */
describe("task work item input and prompt Tasks", () => {
  let apiClient: ReturnType<typeof createScarnTreaty>;
  let project: ProjectContract | undefined;
  let authHeaders: { authorization: string } | undefined;
  let stepDefinition: { id: UuidV7; key: string; version: number } | undefined;

  beforeAll(async () => {
    apiClient = createScarnTreaty(
      createApp(
        createAppContext({
          timeProvider: fixedTimeProvider(new Date("2026-05-01T12:00:00.000Z")),
        }),
      ),
    );
    const owner = await createTestUserAndSession({
      email: `task-work-item-input-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Task Work Item Input Project",
          description: "Project for work item input tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    const created = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        {
          projectId: parseUuidV7(project.id),
          key: `task_work_item_input_${crypto.randomUUID()}`,
          name: "Input step",
          description: "Step for work item input tests",
          prompt: "Work on the work item.",
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
    stepDefinition = {
      id: parseUuidV7(created.id),
      key: created.key,
      version: created.version,
    };
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

  const loadItem = async (workItemId: UuidV7) => {
    const [row] = await getDb()
      .select({ platformKey: workItems.platformKey, title: workItems.title })
      .from(workItems)
      .where(eq(workItems.id, workItemId));
    if (!row) {
      throw new Error(`Expected work item ${workItemId}`);
    }
    return row;
  };

  const postTask = (body: Record<string, unknown>) =>
    apiClient.api.tasks.post(
      body as Parameters<typeof apiClient.api.tasks.post>[0],
      { headers: requireSetup().headers },
    );

  concurrentTest(
    "a standalone Task's input is the caller's input, with no work item",
    async () => {
      const { projectId, headers, stepDefinition } = requireSetup();
      const item = await seedWorkItem(projectId);

      const created = await unwrapAsync(
        apiClient.api.tasks.post(
          {
            projectId,
            workItemId: item,
            stepDefinitionId: stepDefinition.id,
            stepDefinitionVersion: stepDefinition.version,
            inputJson: { ticket: "T-1" },
          },
          { headers },
        ),
      );

      expect(created.task.inputJson).toEqual({ ticket: "T-1" });
    },
  );

  concurrentTest(
    "a pipeline step's input holds its resolved args and no work item or comments",
    async () => {
      const { projectId, headers, stepDefinition } = requireSetup();
      const item = await seedWorkItem(projectId);
      await getDb()
        .update(workItems)
        .set({ fields: { "Severity:": "high" } })
        .where(eq(workItems.id, item));
      const { title } = await loadItem(item);
      const document = singleStepPipelineDocument(
        `work_item_input_${crypto.randomUUID()}`,
        stepDefinition.key,
      );
      const definition = await createPipelineFromDocument(
        apiClient,
        { ...headers },
        projectId,
        {
          ...document,
          workItemFields: { severity: "Severity:" },
          start: {
            ...document.start,
            args: {
              subject: "workItem.title",
              severity: "workItem.fields.severity",
            },
          },
        },
      );
      const execution = await unwrapAsync(
        apiClient.api["pipeline-executions"].post(
          {
            projectId,
            workItemId: item,
            pipelineDefinitionId: definition.id,
          },
          { headers },
        ),
      );
      const task = await unwrapAsync(
        apiClient.api["task-runs"]({
          taskRunId: latestTaskIdForNode(execution),
        }).get({ headers }),
      );

      expect(task.inputJson).toEqual({ subject: title, severity: "high" });
    },
    30_000,
  );

  concurrentTest(
    "a prompt Task is a read-only agent Task, and claimable",
    async () => {
      const { projectId, headers } = requireSetup();
      const workItemId = await seedWorkItem(projectId);

      const created = await unwrapAsync(
        apiClient.api.tasks.post(
          { projectId, workItemId, prompt: "Summarize the work item." },
          { headers },
        ),
      );
      expect(created.task).toMatchObject({
        kind: "agent",
        stepDefinitionId: null,
        retryJson: null,
        grants: [{ resource: "workItem", action: "read", scope: "self" }],
        status: "queued",
        inputJson: null,
      });
      expect(created.task.taskExecutionConfigId).not.toBeNull();
      expect(created.run).toMatchObject({
        status: "queued",
        reason: "initial",
      });

      const claims = await unwrapAsync(
        apiClient.api["task-runs"].claims.post(
          {
            projectId,
            workItemId,
            workerId: `prompt-task-${crypto.randomUUID()}`,
            batchSize: 1,
            leaseDurationSeconds: 30,
          },
          { headers },
        ),
      );
      const claim = claims.find((entry) => entry.task.id === created.run?.id);
      if (!claim) {
        throw new Error("Expected to claim the prompt Task's run");
      }
      const context = await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId: claim.task.id })[
          "worker-context"
        ].post({ claimToken: claim.claimToken }, { headers }),
      );
      expect(context.agentPrompt.promptText).toContain(
        "Your work item is the one this Task runs on (its work item id is above). Read it live with `scarn-get-work-item` before you change it; leave out `workItemId` to read your own. Changes are recorded as you call the tools and applied when your run ends successfully.",
      );
    },
  );

  concurrentTest("a prompt Task on a blocked item waits for work", async () => {
    const { projectId, headers } = requireSetup();
    const [blocked, blocker] = await Promise.all([
      seedWorkItem(projectId),
      seedWorkItem(projectId),
    ]);
    await block(blocked, blocker);

    const created = await unwrapAsync(
      apiClient.api.tasks.post(
        { projectId, workItemId: blocked, prompt: "Do the work." },
        { headers },
      ),
    );
    expect(created.task.status).toBe("waiting_for_work");
    expect(created.run).toBeNull();
  });

  concurrentTest(
    "POST /tasks needs exactly one of a prompt or a step definition",
    async () => {
      const { projectId, stepDefinition } = requireSetup();
      const workItemId = await seedWorkItem(projectId);

      const responses = await Promise.all([
        postTask({ projectId, workItemId }),
        postTask({
          projectId,
          workItemId,
          prompt: "Do the work.",
          stepDefinitionId: stepDefinition.id,
          stepDefinitionVersion: stepDefinition.version,
        }),
        postTask({ projectId, workItemId, prompt: " " }),
      ]);

      for (const response of responses) {
        expect(response.error?.status).toBe(422);
      }
    },
  );
});

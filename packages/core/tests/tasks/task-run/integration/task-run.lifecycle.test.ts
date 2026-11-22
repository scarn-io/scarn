import { beforeAll, describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import {
  fixedTimeProvider,
  serialTest,
  unwrapAsync,
  unwrapStartedTaskAsync,
} from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";
import { createPipelineLinkedTask } from "./task-run-test-support";

const buildDescriptionQualityStepDefinitionPayload = (projectId: UuidV7) => ({
  projectId,
  key: `description_quality_${crypto.randomUUID()}`,
  name: "Description quality",
  description: "Reusable AI quality scoring step",
  prompt: "Read the input and return a completed result.",
  version: 1,
  kind: "user_defined" as const,
  inputSchemaJson: {
    type: "object",
  },
  resultSchemaJson: {
    type: "object",
  },
  status: "active" as const,
});

describe("task lifecycle", () => {
  let apiClient: ReturnType<typeof createScarnTreaty>;
  let project: ProjectContract | undefined;
  let authHeaders: { authorization: string } | undefined;
  let stepDefinitionId: UuidV7 | undefined;
  let stepKey: string | undefined;
  let standaloneTaskId: UuidV7 | undefined;
  let linkedTaskId: UuidV7 | undefined;

  beforeAll(async () => {
    const app = createApp(
      createAppContext({
        timeProvider: fixedTimeProvider(new Date("2026-04-26T12:00:00.000Z")),
      }),
    );
    apiClient = createScarnTreaty(app);
    const owner = await createTestUserAndSession({
      email: `task-lifecycle-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Task Lifecycle Project",
          description: "Project for task lifecycle tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        {
          headers: { ...owner.authHeaders },
        },
      ),
    );

    const stepDefinition = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        buildDescriptionQualityStepDefinitionPayload(parseUuidV7(project.id)),
        { headers: { ...owner.authHeaders } },
      ),
    );
    stepDefinitionId = stepDefinition.id;
    stepKey = stepDefinition.key;
  });

  serialTest("creates a task with projectId", async () => {
    if (!project || !authHeaders || !stepDefinitionId || !stepKey) {
      throw new Error("Expected setup to complete");
    }

    const { run: task } = await unwrapStartedTaskAsync(
      apiClient.api.tasks.post(
        {
          projectId: parseUuidV7(project.id),
          workItemId: await seedWorkItem(parseUuidV7(project.id)),
          stepDefinitionId,
          stepDefinitionVersion: 1,
          inputJson: { ticketId: "ticket-123" },
        },
        { headers: { ...authHeaders } },
      ),
    );

    expect(task.projectId).toBe(project.id);
    expect(task.status).toBe("queued");
    expect(task.inputJson).toMatchObject({ ticketId: "ticket-123" });
    standaloneTaskId = task.id;

    const linked = await createPipelineLinkedTask(
      apiClient,
      authHeaders,
      parseUuidV7(project.id),
      stepKey,
      { ticketId: "ticket-123" },
    );
    linkedTaskId = parseUuidV7(linked.id);
  });

  serialTest("marks a task as running", async () => {
    if (!standaloneTaskId || !authHeaders) {
      throw new Error("Expected task to be created first");
    }

    const task = await unwrapAsync(
      apiClient.api["task-runs"]({ taskRunId: standaloneTaskId }).running.put(
        undefined,
        { headers: { ...authHeaders } },
      ),
    );

    expect(task.status).toBe("running");
    expect(task.startedAt).toBeTruthy();
  });

  serialTest(
    "completes a claimed pipeline task, stores its result, and lists by project",
    async () => {
      if (!linkedTaskId || !authHeaders || !project) {
        throw new Error("Expected task to be created first");
      }
      const projectId = parseUuidV7(project.id);
      const taskRunId = linkedTaskId;
      const linked = await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId: taskRunId }).get({
          headers: { ...authHeaders },
        }),
      );
      expect(linked.inputJson).toMatchObject({ ticketId: "ticket-123" });
      if (linked.workItemId === null) {
        throw new Error("Expected the linked run to have a work item");
      }

      const claims = await unwrapAsync(
        apiClient.api["task-runs"].claims.post(
          {
            projectId,
            workItemId: linked.workItemId,
            workerId: `task-lifecycle-${crypto.randomUUID()}`,
            batchSize: 1,
            leaseDurationSeconds: 30,
          },
          { headers: { ...authHeaders } },
        ),
      );
      const claimToken = claims.find(
        (claim) => claim.task.id === taskRunId,
      )?.claimToken;
      if (!claimToken) {
        throw new Error("Expected to claim the pipeline task");
      }

      const resultJson = {
        criteria: {
          clarity: 0.8,
          reproSteps: 0.6,
        },
      };
      await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId: taskRunId }).completions.post(
          { claimToken, status: "succeeded", resultJson, errorJson: null },
          { headers: { ...authHeaders } },
        ),
      );

      const task = await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId: taskRunId }).get({
          headers: { ...authHeaders },
        }),
      );
      const byProject = await unwrapAsync(
        apiClient.api["task-runs"].get({
          query: { projectId },
          headers: { ...authHeaders },
        }),
      );

      expect(task.status).toBe("succeeded");
      expect(task.resultJson).toEqual(resultJson);
      expect(task.completedAt).toBeTruthy();
      expect(byProject.map((item) => item.id)).toContain(taskRunId);
    },
  );
});

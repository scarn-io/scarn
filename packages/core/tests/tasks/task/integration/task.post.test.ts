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
import { stepDefinitions } from "@/lib/db/schema";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import {
  concurrentTest,
  fixedTimeProvider,
  unwrapAsync,
  unwrapStartedTaskAsync,
} from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";

const createStepDefinitionPayload = (projectId: UuidV7) => ({
  projectId,
  key: `task_post_${crypto.randomUUID()}`,
  name: "Task post step",
  description: "Step for task post tests",
  prompt: "Return a result payload.",
  version: 1,
  kind: "user_defined" as const,
  inputSchemaJson: { type: "object" },
  resultSchemaJson: { type: "object" },
  status: "active" as const,
});

describe("task endpoints", () => {
  let apiClient: ReturnType<typeof createScarnTreaty>;
  let project: ProjectContract | undefined;
  let authHeaders: { authorization: string } | undefined;

  beforeAll(async () => {
    const app = createApp(
      createAppContext({
        timeProvider: fixedTimeProvider(new Date("2026-04-26T12:00:00.000Z")),
      }),
    );
    apiClient = createScarnTreaty(app);
    const owner = await createTestUserAndSession({
      email: `task-post-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Task Post Project",
          description: "Project for task post tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        {
          headers: { ...owner.authHeaders },
        },
      ),
    );
  });

  const requireSetup = () => {
    if (!project || !authHeaders) {
      throw new Error("Expected project auth setup to complete");
    }
    return {
      projectId: parseUuidV7(project.id),
      headers: { ...authHeaders },
    };
  };

  const createStepDefinition = async (projectId: UuidV7) => {
    const { headers } = requireSetup();
    return await unwrapAsync(
      apiClient.api["step-definitions"].post(
        {
          ...createStepDefinitionPayload(projectId),
          repo: { mode: "readOnly" },
        },
        { headers },
      ),
    );
  };

  concurrentTest(
    "returns 401 when the request is unauthenticated",
    async () => {
      const { projectId } = requireSetup();

      const { data, error } = await apiClient.api.tasks.post({
        projectId,
        workItemId: await seedWorkItem(projectId),
        stepDefinitionId: projectId,
        stepDefinitionVersion: 1,
        inputJson: null,
      });

      expect(data).toBeNull();
      expect(error?.status).toBe(401);
    },
  );

  concurrentTest(
    "creates a Task from the step definition with its first run",
    async () => {
      const { projectId, headers } = requireSetup();
      const stepDefinition = await createStepDefinition(projectId);
      const workItemId = await seedWorkItem(projectId);

      const { task, run } = await unwrapAsync(
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

      const [stepDefinitionRow] = await getDb()
        .select({
          taskExecutionConfigId: stepDefinitions.taskExecutionConfigId,
        })
        .from(stepDefinitions)
        .where(eq(stepDefinitions.id, stepDefinition.id));

      expect(stepDefinitionRow?.taskExecutionConfigId).not.toBeNull();
      expect(task).toMatchObject({
        projectId,
        workItemId,
        stepDefinitionId: stepDefinition.id,
        taskExecutionConfigId: stepDefinitionRow?.taskExecutionConfigId,
        name: "Task post step",
        kind: "agent",
        status: "queued",
        previousTaskId: null,
      });
      expect(run).toMatchObject({
        taskId: task.id,
        projectId,
        workItemId,
        number: 1,
        reason: "initial",
        status: "queued",
        previousTaskRunId: null,
        taskExecutionConfigId: stepDefinitionRow?.taskExecutionConfigId,
        name: "Task post step",
        kind: "agent",
      });
    },
  );

  concurrentTest("reads a Task and lists its runs", async () => {
    const { projectId, headers } = requireSetup();
    const stepDefinition = await createStepDefinition(projectId);
    const created = await unwrapStartedTaskAsync(
      apiClient.api.tasks.post(
        {
          projectId,
          workItemId: await seedWorkItem(projectId),
          stepDefinitionId: stepDefinition.id,
          stepDefinitionVersion: stepDefinition.version,
          inputJson: null,
        },
        { headers },
      ),
    );

    const task = await unwrapAsync(
      apiClient.api.tasks({ taskId: created.task.id }).get({ headers }),
    );
    const runs = await unwrapAsync(
      apiClient.api.tasks({ taskId: created.task.id }).runs.get({ headers }),
    );

    expect(task).toMatchObject(created.task);
    expect(
      runs.map(({ id, number, reason }) => ({ id, number, reason })),
    ).toEqual([{ id: created.run.id, number: 1, reason: "initial" }]);
  });

  concurrentTest("returns 404 for an unknown Task", async () => {
    const { headers } = requireSetup();
    const taskId = createUuidV7();

    const read = await apiClient.api.tasks({ taskId }).get({ headers });
    const runs = await apiClient.api.tasks({ taskId }).runs.get({ headers });

    expect(read.error?.status).toBe(404);
    expect(runs.error?.status).toBe(404);
  });

  concurrentTest(
    "rejects a step definition version that does not match",
    async () => {
      const { projectId, headers } = requireSetup();
      const stepDefinition = await unwrapAsync(
        apiClient.api["step-definitions"].post(
          createStepDefinitionPayload(projectId),
          { headers },
        ),
      );

      const { data, error } = await apiClient.api.tasks.post(
        {
          projectId,
          workItemId: await seedWorkItem(projectId),
          stepDefinitionId: stepDefinition.id,
          stepDefinitionVersion: stepDefinition.version + 1,
          inputJson: null,
        },
        { headers },
      );

      expect(data).toBeNull();
      expect(error?.status).toBe(422);
    },
  );

  concurrentTest("returns 404 for a work item in another project", async () => {
    const { projectId, headers } = requireSetup();
    const stepDefinition = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        createStepDefinitionPayload(projectId),
        { headers },
      ),
    );
    const otherProject = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Task Post Other Project",
          description: "Owns a work item the first project cannot use",
          gitUrl: "https://github.com/example/other-project.git",
        },
        { headers },
      ),
    );

    const { data, error } = await apiClient.api.tasks.post(
      {
        projectId,
        workItemId: await seedWorkItem(parseUuidV7(otherProject.id)),
        stepDefinitionId: stepDefinition.id,
        stepDefinitionVersion: stepDefinition.version,
        inputJson: null,
      },
      { headers },
    );

    expect(data).toBeNull();
    expect(error?.status).toBe(404);
  });
});

import { beforeAll, describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import {
  concurrentTest,
  fixedTimeProvider,
  unwrapAsync,
  unwrapStartedTaskAsync,
} from "tests/utils";
import { v7 as uuidv7 } from "uuid";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";

const buildStepDefinitionPayload = (projectId: UuidV7, key: string) => ({
  projectId,
  key,
  name: "Artifact failure post step",
  description: "Reusable step for artifact-failure POST edge cases",
  prompt: "Return a result payload.",
  version: 1,
  kind: "user_defined" as const,
  inputSchemaJson: { type: "object" },
  resultSchemaJson: { type: "object" },
  status: "active" as const,
});

describe("task artifact failure post endpoint", () => {
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-05-01T12:00:00.000Z")),
    }),
  );
  const apiClient = createScarnTreaty(app);
  let project: ProjectContract | undefined;
  let authHeaders: { authorization: string } | undefined;
  let stepDefinitionId: UuidV7 | undefined;

  beforeAll(async () => {
    const owner = await createTestUserAndSession({
      email: `task-artifact-failure-post-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Task Artifact Failure Post Project",
          description: "Project for task artifact-failure POST tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    const stepDefinition = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        buildStepDefinitionPayload(
          parseUuidV7(project.id),
          `artifact_failure_post_step_${crypto.randomUUID()}`,
        ),
        { headers: { ...owner.authHeaders } },
      ),
    );
    stepDefinitionId = stepDefinition.id;
  });

  const claimStep = async (
    workerId: string,
  ): Promise<{ taskRunId: UuidV7; claimToken: string }> => {
    if (!project || !authHeaders || !stepDefinitionId) {
      throw new Error("Expected setup to complete");
    }
    const { run: task } = await unwrapStartedTaskAsync(
      apiClient.api.tasks.post(
        {
          projectId: parseUuidV7(project.id),
          workItemId: await seedWorkItem(parseUuidV7(project.id)),
          stepDefinitionId,
          stepDefinitionVersion: 1,
          inputJson: { ticketId: `ticket-${workerId}` },
          executionTimeoutSeconds: 300,
        },
        { headers: { ...authHeaders } },
      ),
    );
    const claims = await unwrapAsync(
      apiClient.api["task-runs"].claims.post(
        {
          projectId: parseUuidV7(project.id),
          workerId,
          batchSize: 1,
          leaseDurationSeconds: 30,
        },
        { headers: { ...authHeaders } },
      ),
    );
    const claimToken = claims[0]?.claimToken;
    if (!claimToken) {
      throw new Error("Expected claim token to be returned");
    }
    return { taskRunId: task.id, claimToken };
  };

  concurrentTest("returns 409 when the claim token is wrong", async () => {
    const { taskRunId } = await claimStep("worker-artifact-failure-bad-token");

    const response = await apiClient.api["task-runs"]({
      taskRunId: taskRunId,
    })["artifact-failures"].post(
      {
        claimToken: "not-the-real-claim-token",
        relativeStorePath: "reports/summary.json",
        attemptedSizeBytes: 1024,
        errorCode: "UPLOAD_HTTP_ERROR",
        errorMessage: "Upload request failed",
      },
      { headers: { ...authHeaders } },
    );

    expect(response.data).toBeNull();
    expect(response.error?.status).toBe(409);
    expect(response.error?.value).toMatchObject({
      code: "TASK_OWNERSHIP_CONFLICT",
    });
  });

  concurrentTest("returns 404 for an unknown task id", async () => {
    const { data, error } = await apiClient.api["task-runs"]({
      taskRunId: uuidv7(),
    })["artifact-failures"].post(
      {
        claimToken: "some-token",
        relativeStorePath: "reports/summary.json",
        attemptedSizeBytes: 1024,
        errorCode: "UPLOAD_HTTP_ERROR",
        errorMessage: "Upload request failed",
      },
      { headers: { ...authHeaders } },
    );

    expect(data).toBeNull();
    expect(error?.status).toBe(404);
    expect(error?.value).toMatchObject({
      code: "TASK_NOT_FOUND",
    });
  });

  concurrentTest(
    "returns 422 when required body fields are missing",
    async () => {
      const { taskRunId, claimToken } = await claimStep(
        "worker-artifact-failure-missing-fields",
      );

      const { data, error } = await apiClient.api["task-runs"]({
        taskRunId: taskRunId,
      })["artifact-failures"].post(
        {
          claimToken,
          relativeStorePath: "reports/summary.json",
        } as never,
        { headers: { ...authHeaders } },
      );

      expect(data).toBeNull();
      expect(error?.status).toBe(422);
      expect(error?.value).toMatchObject({
        status: 422,
        code: "VALIDATION",
        title: "Unprocessable Content",
      });
    },
  );

  concurrentTest(
    "returns 422 when attemptedSizeBytes is negative",
    async () => {
      const { taskRunId, claimToken } = await claimStep(
        "worker-artifact-failure-invalid-size",
      );

      const { data, error } = await apiClient.api["task-runs"]({
        taskRunId: taskRunId,
      })["artifact-failures"].post(
        {
          claimToken,
          relativeStorePath: "reports/summary.json",
          attemptedSizeBytes: -1,
          errorCode: "UPLOAD_HTTP_ERROR",
          errorMessage: "Upload request failed",
        },
        { headers: { ...authHeaders } },
      );

      expect(data).toBeNull();
      expect(error?.status).toBe(422);
      expect(error?.value).toMatchObject({
        status: 422,
        code: "VALIDATION",
        title: "Unprocessable Content",
      });
    },
  );

  concurrentTest(
    "returns 403 when the caller lacks executions:write on the project",
    async () => {
      const { taskRunId, claimToken } = await claimStep(
        "worker-artifact-failure-forbidden",
      );
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }
      const outsider = await createTestUserAndSession({
        email: `task-artifact-failure-outsider-${crypto.randomUUID()}@example.com`,
      });
      await unwrapAsync(
        apiClient.api
          .projects({ projectId: project.id })
          .members({ userId: outsider.userId })
          .role.put({ role: "read" }, { headers: { ...authHeaders } }),
      );

      const { data, error } = await apiClient.api["task-runs"]({
        taskRunId: taskRunId,
      })["artifact-failures"].post(
        {
          claimToken,
          relativeStorePath: "reports/summary.json",
          attemptedSizeBytes: 1024,
          errorCode: "UPLOAD_HTTP_ERROR",
          errorMessage: "Upload request failed",
        },
        { headers: { ...outsider.authHeaders } },
      );

      expect(data).toBeNull();
      expect(error?.status).toBe(403);
      expect(error?.value).toMatchObject({
        status: 403,
        code: "PROJECT_FORBIDDEN",
      });
    },
  );

  concurrentTest(
    "returns 401 when the request is unauthenticated",
    async () => {
      const { taskRunId, claimToken } = await claimStep(
        "worker-artifact-failure-unauthenticated",
      );

      const { data, error } = await apiClient.api["task-runs"]({
        taskRunId: taskRunId,
      })["artifact-failures"].post({
        claimToken,
        relativeStorePath: "reports/summary.json",
        attemptedSizeBytes: 1024,
        errorCode: "UPLOAD_HTTP_ERROR",
        errorMessage: "Upload request failed",
      });

      expect(data).toBeNull();
      expect(error?.status).toBe(401);
    },
  );
});

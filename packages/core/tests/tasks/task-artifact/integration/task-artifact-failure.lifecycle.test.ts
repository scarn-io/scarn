import { beforeAll, describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import type { TimeProvider } from "@/lib/time-provider";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import { serialTest, unwrapAsync, unwrapStartedTaskAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";

const buildStepDefinitionPayload = (projectId: UuidV7, key: string) => ({
  projectId,
  key,
  name: "Artifact failure step",
  description: "Reusable step for artifact-failure lifecycle tests",
  prompt: "Return a result payload.",
  version: 1,
  kind: "user_defined" as const,
  inputSchemaJson: { type: "object" },
  resultSchemaJson: { type: "object" },
  status: "active" as const,
});

/**
 * Serial smoke test mirroring `task.artifacts.test.ts`'s pattern:
 * record a failed upload attempt (POST) then confirm it shows up in the list
 * (GET) with the right shape, end to end through the live Elysia app +
 * Postgres.
 */
describe("task artifact failures", () => {
  let currentTime = new Date("2026-05-01T12:00:00.000Z");
  const timeProvider: TimeProvider = {
    now: () => currentTime,
    nowIso: () => currentTime.toISOString(),
  };
  const app = createApp(createAppContext({ timeProvider }));
  const apiClient = createScarnTreaty(app);
  let project: ProjectContract | undefined;
  let authHeaders: { authorization: string } | undefined;
  let stepDefinitionId: UuidV7 | undefined;

  beforeAll(async () => {
    const owner = await createTestUserAndSession({
      email: `task-artifact-failure-lifecycle-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Task Artifact Failure Lifecycle Project",
          description: "Project for task artifact-failure lifecycle tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    const stepDefinition = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        buildStepDefinitionPayload(
          parseUuidV7(project.id),
          `artifact_failure_step_${crypto.randomUUID()}`,
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

  serialTest("records a failed artifact upload and lists it back", async () => {
    currentTime = new Date("2026-05-01T12:00:00.000Z");
    const { taskRunId, claimToken } = await claimStep(
      "worker-artifact-failure",
    );

    const recorded = await unwrapAsync(
      apiClient.api["task-runs"]({ taskRunId: taskRunId })[
        "artifact-failures"
      ].post(
        {
          claimToken,
          relativeStorePath: "reports/summary.json",
          attemptedSizeBytes: 4096,
          kind: "generic",
          errorCode: "UPLOAD_HTTP_ERROR",
          errorMessage: "Upload request failed with status 502",
          httpStatus: 502,
        },
        { headers: { ...authHeaders } },
      ),
    );

    expect(recorded.taskRunId).toBe(taskRunId);
    expect(recorded.relativeStorePath).toBe("reports/summary.json");
    expect(recorded.attemptedSizeBytes).toBe(4096);
    expect(recorded.kind).toBe("generic");
    expect(recorded.errorCode).toBe("UPLOAD_HTTP_ERROR");
    expect(recorded.errorMessage).toBe("Upload request failed with status 502");
    expect(recorded.httpStatus).toBe(502);

    const listed = await unwrapAsync(
      apiClient.api["task-runs"]({ taskRunId: taskRunId })[
        "artifact-failures"
      ].get({ headers: { ...authHeaders } }),
    );

    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(recorded.id);
    expect(listed[0]?.relativeStorePath).toBe("reports/summary.json");
    expect(listed[0]?.errorCode).toBe("UPLOAD_HTTP_ERROR");
  });

  serialTest(
    "defaults kind to generic and httpStatus to null when omitted",
    async () => {
      currentTime = new Date("2026-05-01T12:10:00.000Z");
      const { taskRunId, claimToken } = await claimStep(
        "worker-artifact-failure-defaults",
      );

      const recorded = await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId: taskRunId })[
          "artifact-failures"
        ].post(
          {
            claimToken,
            relativeStorePath: "reports/summary.json",
            attemptedSizeBytes: 1024,
            errorCode: "UNKNOWN_ERROR",
            errorMessage: "Something went wrong",
          },
          { headers: { ...authHeaders } },
        ),
      );

      expect(recorded.kind).toBe("generic");
      expect(recorded.httpStatus).toBeNull();
    },
  );
});

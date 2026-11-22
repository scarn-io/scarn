import { eq } from "drizzle-orm";
import { describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import {
  concurrentTest,
  unwrapAsync,
  unwrapStartedTaskAsync,
} from "tests/utils";
import { v7 as uuidv7 } from "uuid";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";

/**
 * No `fixedTimeProvider` override — the ordering assertion below depends on
 * successive artifact-failure rows actually getting distinct `createdAt`
 * values from the real clock (the DB's own `now()` default, per
 * `taskArtifactFailures.createdAt`), which a frozen time provider
 * would collapse to one instant. Mirrors
 * `work-items/work-item/integration/work-item.children.test.ts`.
 *
 * Each test builds its own project/step-definition/task rather
 * than sharing one across the describe block (unlike most sibling
 * integration files): the public-project test flips a project's visibility
 * via a direct DB write, which would otherwise race against the other
 * `concurrentTest` cases sharing the same row.
 */
describe("task artifact failure get endpoint", () => {
  const app = createApp(createAppContext());
  const apiClient = createScarnTreaty(app);

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  const setup = async (
    label: string,
  ): Promise<{
    owner: { authHeaders: { authorization: string } };
    project: ProjectContract;
    stepDefinitionId: UuidV7;
  }> => {
    const owner = await createTestUserAndSession({
      email: `${label}-${crypto.randomUUID()}@example.com`,
    });
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: `Artifact Failure Get ${label}`,
          description: `Project for the "${label}" artifact-failure GET test`,
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    const stepDefinition = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        {
          projectId: parseUuidV7(project.id),
          key: `artifact_failure_get_${label}_${crypto.randomUUID()}`,
          name: "Artifact failure get step",
          description: "Reusable step for artifact-failure GET edge cases",
          prompt: "Return a result payload.",
          version: 1,
          kind: "user_defined" as const,
          inputSchemaJson: { type: "object" },
          resultSchemaJson: { type: "object" },
          status: "active" as const,
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    return { owner, project, stepDefinitionId: stepDefinition.id };
  };

  const claimStep = async (
    owner: { authHeaders: { authorization: string } },
    project: ProjectContract,
    stepDefinitionId: UuidV7,
    workerId: string,
  ): Promise<{ taskRunId: UuidV7; claimToken: string }> => {
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
        { headers: { ...owner.authHeaders } },
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
        { headers: { ...owner.authHeaders } },
      ),
    );
    const claimToken = claims[0]?.claimToken;
    if (!claimToken) {
      throw new Error("Expected claim token to be returned");
    }
    return { taskRunId: task.id, claimToken };
  };

  const recordFailure = (
    owner: { authHeaders: { authorization: string } },
    taskRunId: UuidV7,
    claimToken: string,
    relativeStorePath: string,
  ) =>
    unwrapAsync(
      apiClient.api["task-runs"]({ taskRunId: taskRunId })[
        "artifact-failures"
      ].post(
        {
          claimToken,
          relativeStorePath,
          attemptedSizeBytes: 1024,
          errorCode: "UPLOAD_HTTP_ERROR",
          errorMessage: "Upload request failed",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );

  concurrentTest("returns 404 for an unknown task id", async () => {
    const { owner } = await setup("unknown-id");

    const { data, error } = await apiClient.api["task-runs"]({
      taskRunId: uuidv7(),
    })["artifact-failures"].get({ headers: { ...owner.authHeaders } });

    expect(data).toBeNull();
    expect(error?.status).toBe(404);
    expect(error?.value).toMatchObject({
      code: "TASK_NOT_FOUND",
    });
  });

  concurrentTest("lists failures newest first", async () => {
    const { owner, project, stepDefinitionId } = await setup("ordering");
    const { taskRunId, claimToken } = await claimStep(
      owner,
      project,
      stepDefinitionId,
      "worker-artifact-failure-order",
    );

    const older = await recordFailure(
      owner,
      taskRunId,
      claimToken,
      "reports/older.json",
    );
    await sleep(5);
    const newer = await recordFailure(
      owner,
      taskRunId,
      claimToken,
      "reports/newer.json",
    );

    const listed = await unwrapAsync(
      apiClient.api["task-runs"]({ taskRunId: taskRunId })[
        "artifact-failures"
      ].get({ headers: { ...owner.authHeaders } }),
    );

    expect(listed.map((failure) => failure.id)).toEqual([newer.id, older.id]);
  });

  concurrentTest(
    "an anonymous caller can read a public project's task artifact failures",
    async () => {
      const { owner, project, stepDefinitionId } = await setup("public-anon");
      const { taskRunId, claimToken } = await claimStep(
        owner,
        project,
        stepDefinitionId,
        "worker-artifact-failure-public",
      );
      await recordFailure(owner, taskRunId, claimToken, "reports/public.json");
      await getDb()
        .update(projects)
        .set({ visibility: "public" })
        .where(eq(projects.id, project.id));

      const { data, error } = await apiClient.api["task-runs"]({
        taskRunId: taskRunId,
      })["artifact-failures"].get();

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
      expect(data?.[0]?.relativeStorePath).toBe("reports/public.json");
    },
  );

  concurrentTest(
    "a logged-in non-member is denied a private project's task artifact failures",
    async () => {
      const { owner, project, stepDefinitionId } =
        await setup("private-denied");
      const { taskRunId } = await claimStep(
        owner,
        project,
        stepDefinitionId,
        "worker-artifact-failure-private-denied",
      );
      const outsider = await createTestUserAndSession({
        email: `task-artifact-failure-outsider-${crypto.randomUUID()}@example.com`,
      });

      const { data, error } = await apiClient.api["task-runs"]({
        taskRunId: taskRunId,
      })["artifact-failures"].get({ headers: { ...outsider.authHeaders } });

      expect(data).toBeNull();
      expect(error?.status).toBe(403);
    },
  );
});

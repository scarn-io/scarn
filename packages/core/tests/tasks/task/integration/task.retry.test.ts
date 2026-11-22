import { beforeAll, describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import {
  concurrentTest,
  fixedTimeProvider,
  unwrapAsync,
  unwrapStartedTaskAsync,
} from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";

describe("a standalone Task's retries", () => {
  let apiClient: ReturnType<typeof createScarnTreaty>;
  let project: ProjectContract | undefined;
  let authHeaders: { authorization: string } | undefined;

  beforeAll(async () => {
    const app = createApp(
      createAppContext({
        timeProvider: fixedTimeProvider(new Date("2026-10-28T12:00:00.000Z")),
      }),
    );
    apiClient = createScarnTreaty(app);
    const owner = await createTestUserAndSession({
      email: `task-retry-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Task Retry Project",
          description: "Project for task retry tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
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

  const stepPayload = (
    projectId: UuidV7,
    retry: { on: string[]; maxAttempts: number }[],
  ) => ({
    projectId,
    key: `task_retry_${crypto.randomUUID()}`,
    name: "Task retry step",
    description: "Step for task retry tests",
    prompt: "Return a result payload.",
    version: 1,
    kind: "user_defined" as const,
    inputSchemaJson: { type: "object" },
    resultSchemaJson: { type: "object" },
    errors: ["MergeConflict"],
    retry,
    repo: { mode: "readOnly" as const },
    status: "active" as const,
  });

  const createTask = async (retry: { on: string[]; maxAttempts: number }[]) => {
    const { projectId, headers } = requireSetup();
    const stepDefinition = await unwrapAsync(
      apiClient.api["step-definitions"].post(stepPayload(projectId, retry), {
        headers,
      }),
    );
    const workItemId = await seedWorkItem(projectId);
    const created = await unwrapStartedTaskAsync(
      apiClient.api.tasks.post(
        {
          projectId,
          workItemId,
          stepDefinitionId: stepDefinition.id,
          stepDefinitionVersion: stepDefinition.version,
          inputJson: { ticket: "T-1" },
        },
        { headers },
      ),
    );
    return { ...created, stepDefinition, workItemId };
  };

  const claimAndFail = async (
    workItemId: string,
    taskRunId: string,
    errorJson: { name: string; message: string },
  ) => {
    const { projectId, headers } = requireSetup();
    const claims = await unwrapAsync(
      apiClient.api["task-runs"].claims.post(
        {
          projectId,
          workItemId,
          workerId: `task-retry-${crypto.randomUUID()}`,
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
      throw new Error(`Expected to claim run ${taskRunId}`);
    }
    await unwrapAsync(
      apiClient.api["task-runs"]({ taskRunId }).completions.post(
        { claimToken, status: "failed", resultJson: null, errorJson },
        { headers },
      ),
    );
  };

  const readTask = async (taskId: string) => {
    const { headers } = requireSetup();
    const [task, runs] = await Promise.all([
      unwrapAsync(apiClient.api.tasks({ taskId }).get({ headers })),
      unwrapAsync(apiClient.api.tasks({ taskId }).runs.get({ headers })),
    ]);
    return { task, runs };
  };

  concurrentTest(
    "competing manual requests create exactly one retry run",
    async () => {
      const created = await createTask([]);
      const { headers } = requireSetup();
      await claimAndFail(created.workItemId, created.run.id, {
        name: "Scarn.StepFailed",
        message: "try again",
      });

      const responses = await Promise.all(
        Array.from({ length: 2 }, () =>
          apiClient.api
            .tasks({ taskId: created.task.id })
            .retry.post({ expectedLatestRunId: created.run.id }, { headers }),
        ),
      );
      expect(responses.filter((response) => response.data)).toHaveLength(1);
      expect(responses.find((response) => response.error)?.error).toMatchObject(
        {
          status: 409,
          value: { code: "TASK_RETRY_STALE_RUN" },
        },
      );
      const retried = responses.find((response) => response.data)?.data;
      if (!retried) throw new Error("Expected one successful retry");

      expect(retried.taskId).toBe(created.task.id);
      const { task, runs } = await readTask(created.task.id);
      expect(task.status).toBe("queued");
      expect(runs).toHaveLength(2);
      expect(runs[1]).toMatchObject({
        id: retried.taskRunId,
        number: 2,
        reason: "retry",
        status: "queued",
      });
      expect(retried.taskRunId).not.toBeNull();
    },
  );

  concurrentTest(
    "retries a cancelled Task and rejects a stale repeat",
    async () => {
      const created = await createTask([]);
      const { headers } = requireSetup();
      const endpoint = apiClient.api.tasks({ taskId: created.task.id });
      await unwrapAsync(endpoint.cancel.post(undefined, { headers }));

      const retried = await unwrapAsync(
        endpoint.retry.post(
          { expectedLatestRunId: created.run.id },
          { headers },
        ),
      );
      expect(retried.taskId).toBe(created.task.id);
      expect(retried.taskRunId).not.toBeNull();
      const stale = await endpoint.retry.post(
        { expectedLatestRunId: created.run.id },
        { headers },
      );
      expect(stale.error?.status).toBe(409);
      expect(stale.error?.value).toMatchObject({
        code: "TASK_RETRY_STALE_RUN",
      });
      expect((await readTask(created.task.id)).runs).toHaveLength(2);
    },
  );

  concurrentTest(
    "requires authentication and project access to retry",
    async () => {
      const created = await createTask([]);
      const endpoint = apiClient.api.tasks({ taskId: created.task.id }).retry;
      const body = { expectedLatestRunId: created.run.id };
      expect((await endpoint.post(body)).error?.status).toBe(401);

      const outsider = await createTestUserAndSession({
        email: `task-retry-outsider-${crypto.randomUUID()}@example.com`,
      });
      expect(
        (await endpoint.post(body, { headers: outsider.authHeaders })).error
          ?.status,
      ).toBe(403);
      expect((await readTask(created.task.id)).runs).toHaveLength(1);
    },
  );

  concurrentTest(
    "returns 404 for an unknown Task and 422 for an active Task",
    async () => {
      const { headers } = requireSetup();
      const missing = await apiClient.api
        .tasks({ taskId: createUuidV7() })
        .retry.post({ expectedLatestRunId: null }, { headers });
      expect(missing.error?.status).toBe(404);

      const created = await createTask([]);
      const active = await apiClient.api
        .tasks({ taskId: created.task.id })
        .retry.post({ expectedLatestRunId: created.run.id }, { headers });
      expect(active.error?.status).toBe(422);
      expect(active.error?.value).toMatchObject({ code: "TASK_NOT_RETRYABLE" });
    },
  );

  concurrentTest(
    "requires the latest-run guard in the request body",
    async () => {
      const created = await createTask([]);
      const { headers } = requireSetup();
      const response = await apiClient.api
        .tasks({ taskId: created.task.id })
        .retry.post(
          // @ts-expect-error Exercise a request that omits the required guard.
          {},
          { headers },
        );

      expect(response.error?.status).toBe(422);
      expect((await readTask(created.task.id)).runs).toHaveLength(1);
    },
  );

  concurrentTest(
    "copies automatic retry policy and a manual retry does not reset its exhausted budget",
    async () => {
      const created = await createTask([
        { on: ["MergeConflict"], maxAttempts: 1 },
      ]);
      expect(created.stepDefinition.retry).toEqual([
        { on: ["MergeConflict"], maxAttempts: 1 },
      ]);
      const conflict = { name: "MergeConflict", message: "rebase failed" };

      await claimAndFail(created.workItemId, created.run.id, conflict);

      const afterFirst = await readTask(created.task.id);
      expect(afterFirst.task.status).toBe("queued");
      expect(
        afterFirst.runs.map(({ number, reason, status, inputJson }) => ({
          number,
          reason,
          status,
          inputJson,
        })),
      ).toMatchObject([
        {
          number: 1,
          reason: "initial",
          status: "failed",
          inputJson: { ticket: "T-1" },
        },
        {
          number: 2,
          reason: "retry",
          status: "queued",
          inputJson: { ticket: "T-1" },
        },
      ]);

      const retry = afterFirst.runs.find((run) => run.number === 2);
      if (!retry) {
        throw new Error("Expected a retry run");
      }
      await claimAndFail(created.workItemId, retry.id, conflict);

      const afterSecond = await readTask(created.task.id);
      expect(afterSecond.runs).toHaveLength(2);
      expect(afterSecond.task.status).toBe("failed");
      expect(afterSecond.task.errorJson).toMatchObject(conflict);

      const { headers } = requireSetup();
      const manual = await unwrapAsync(
        apiClient.api
          .tasks({ taskId: created.task.id })
          .retry.post({ expectedLatestRunId: retry.id }, { headers }),
      );
      if (!manual.taskRunId) throw new Error("Expected manual retry run");
      await claimAndFail(created.workItemId, manual.taskRunId, conflict);
      const afterManual = await readTask(created.task.id);
      expect(afterManual.task.status).toBe("failed");
      expect(afterManual.runs).toHaveLength(3);
      expect(afterManual.runs.map((run) => run.status)).toEqual([
        "failed",
        "failed",
        "failed",
      ]);
    },
  );

  concurrentTest(
    "an error the step's retry doesn't name fails the Task",
    async () => {
      const created = await createTask([
        { on: ["MergeConflict"], maxAttempts: 3 },
      ]);

      await claimAndFail(created.workItemId, created.run.id, {
        name: "Scarn.StepFailed",
        message: "boom",
      });

      const { task, runs } = await readTask(created.task.id);
      expect(runs).toHaveLength(1);
      expect(task.status).toBe("failed");
      expect(task.errorJson).toMatchObject({ name: "Scarn.StepFailed" });
    },
  );

  concurrentTest(
    "a step whose retry names an undeclared error is rejected",
    async () => {
      const { projectId, headers } = requireSetup();

      const { error } = await apiClient.api["step-definitions"].post(
        stepPayload(projectId, [{ on: ["MergeConflit"], maxAttempts: 1 }]),
        { headers },
      );

      expect(error?.status).toBe(422);
    },
  );
});

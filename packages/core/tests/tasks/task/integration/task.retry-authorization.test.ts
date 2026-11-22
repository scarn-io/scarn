import { beforeAll, describe, expect } from "bun:test";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { createQuestionHarness } from "tests/pipeline-executions/pipeline-run/integration/question-test-support";
import { createHandOverHarness } from "./hand-over-test-support";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";

describe("retry project permissions", () => {
  const h = createHandOverHarness();
  concurrentTest(
    "a project reader without executions:write cannot retry",
    async () => {
      const { projectId, headers } = h.requireSetup();
      const reader = await createTestUserAndSession({
        email: `retry-reader-${crypto.randomUUID()}@example.com`,
      });
      await unwrapAsync(
        h.apiClient.api
          .projects({ projectId })
          .members({ userId: reader.userId })
          .role.put({ role: "read" }, { headers }),
      );
      const { taskId, taskRunId } = await h.startTask(await h.seedItem());
      const endpoint = h.apiClient.api.tasks({ taskId });
      await unwrapAsync(endpoint.cancel.post(undefined, { headers }));
      const before = await unwrapAsync(endpoint.get({ headers }));
      const denied = await endpoint.retry.post(
        { expectedLatestRunId: taskRunId },
        { headers: reader.authHeaders },
      );
      expect(denied.error?.status).toBe(403);
      expect(await unwrapAsync(endpoint.get({ headers }))).toEqual(before);
      expect(await unwrapAsync(endpoint.runs.get({ headers }))).toHaveLength(1);
    },
  );
});

describe("pipeline-owned retry rejection", () => {
  const { harness: h, headers } = createQuestionHarness("retry-pipeline");
  beforeAll(async () => {
    await h.setUp();
  });

  concurrentTest(
    "a failed pipeline Task directs callers to rerun without changing history",
    async () => {
      const { executionId, workItemId } = await h.startRun({
        schemaVersion: 1,
        key: h.uniqueKey("retry-owned"),
        start: { to: "only" },
        nodes: {
          only: {
            kind: "step",
            step: h.requireSetup().stepKey,
            next: { routes: [{ to: "done" }] },
          },
          done: { kind: "succeed" },
        },
      });
      const claim = await h.claimOne(parseUuidV7(workItemId));
      await h.complete(claim, "failed", null, {
        name: "Scarn.StepFailed",
        message: "pipeline failure",
      });
      const run = await unwrapAsync(
        h.apiClient.api["task-runs"]({ taskRunId: claim.taskId }).get({
          headers: headers(),
        }),
      );
      const endpoint = h.apiClient.api.tasks({ taskId: run.taskId });
      const before = await unwrapAsync(
        endpoint.runs.get({ headers: headers() }),
      );
      const pipelineBefore = await h.getRun(executionId);
      const refused = await endpoint.retry.post(
        { expectedLatestRunId: run.id },
        { headers: headers() },
      );
      expect(refused.error?.status).toBe(422);
      expect(refused.error?.value).toMatchObject({
        code: "TASK_RETRY_PIPELINE_OWNED",
      });
      expect(JSON.stringify(refused.error?.value)).toContain("rerun");
      expect(
        await unwrapAsync(endpoint.runs.get({ headers: headers() })),
      ).toEqual(before);
      expect(
        (await unwrapAsync(endpoint.get({ headers: headers() }))).status,
      ).toBe("failed");
      expect(await h.getRun(executionId)).toEqual(pipelineBefore);
    },
  );
});

import { describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import { RecordingAnalytics } from "@/lib/analytics/recording-analytics";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import {
  buildStepDefinitionPayload,
  createPipelineLinkedTask,
} from "./task-run-test-support";

/**
 * `investigation_report_produced` through the worker completion route: one
 * capture when a succeeded Task's result carries a non-empty `report`, none
 * otherwise, and only booleans derived from the result — never its text.
 */

describe("investigation report analytics", () => {
  const analytics = new RecordingAnalytics();
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-04-26T12:00:00.000Z")),
      analytics,
    }),
  );
  const apiClient = createScarnTreaty(app);

  const reportsFor = (taskRunId: string) =>
    analytics
      .callsFor("investigation_report_produced")
      .filter((call) => call.properties.task_id === taskRunId);

  const completeTask = async (
    label: string,
    status: "succeeded" | "failed",
    resultJson: AnyJsonValue,
  ) => {
    const owner = await createTestUserAndSession({
      email: `report-analytics-${label}-${crypto.randomUUID()}@example.com`,
    });
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: `Report Analytics ${label}`,
          description: null,
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    const projectId = parseUuidV7(project.id);
    const stepDefinition = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        buildStepDefinitionPayload(
          projectId,
          `report_analytics_${crypto.randomUUID()}`,
        ),
        { headers: { ...owner.authHeaders } },
      ),
    );
    const task = await createPipelineLinkedTask(
      apiClient,
      owner.authHeaders,
      projectId,
      stepDefinition.key,
    );
    const claims = await unwrapAsync(
      apiClient.api["task-runs"].claims.post(
        {
          projectId,
          workerId: `report-analytics-worker-${crypto.randomUUID()}`,
          batchSize: 1,
          leaseDurationSeconds: 30,
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    const claim = claims.find((candidate) => candidate.task.id === task.id);
    if (!claim) throw new Error("Expected to claim the pipeline-linked task");

    await unwrapAsync(
      apiClient.api["task-runs"]({ taskRunId: claim.task.id }).completions.post(
        {
          claimToken: claim.claimToken,
          status,
          resultJson,
          errorJson: status === "failed" ? { message: "step failed" } : null,
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    return { owner, projectId, taskRunId: claim.task.id };
  };

  concurrentTest(
    "a succeeded result with a report captures one event for the completing actor",
    async () => {
      const { owner, projectId, taskRunId } = await completeTask(
        "report",
        "succeeded",
        {
          report: "Checkout total ignores the discount code.",
          reproduced: true,
          tracePath: ".scarn/step-artifacts/repro.zip",
        },
      );

      expect(reportsFor(taskRunId)).toEqual([
        {
          distinctId: owner.userId,
          event: "investigation_report_produced",
          properties: {
            project_id: projectId,
            task_id: taskRunId,
            reproduced: true,
            has_trace: true,
          },
        },
      ]);
    },
  );

  concurrentTest(
    "an unreproduced report without a trace reports both flags as false",
    async () => {
      const { taskRunId } = await completeTask("unreproduced", "succeeded", {
        report: "Could not reach the checkout page.",
        reproduced: false,
      });

      expect(reportsFor(taskRunId)).toMatchObject([
        { properties: { reproduced: false, has_trace: false } },
      ]);
    },
  );

  concurrentTest(
    "a result without a report, or a failed task, captures nothing",
    async () => {
      const noReport = await completeTask("no-report", "succeeded", {
        summary: "done",
      });
      const blankReport = await completeTask("blank-report", "succeeded", {
        report: "  ",
      });
      const failed = await completeTask("failed", "failed", {
        report: "Partial findings.",
      });

      expect(reportsFor(noReport.taskRunId)).toEqual([]);
      expect(reportsFor(blankReport.taskRunId)).toEqual([]);
      expect(reportsFor(failed.taskRunId)).toEqual([]);
    },
  );
});

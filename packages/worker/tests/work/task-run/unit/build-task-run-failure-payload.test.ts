import { describe, expect, test } from "bun:test";
import { buildTaskRunFailurePayload } from "../../../../src/work/task-run/application/build-task-run-failure-payload";
import { HealthCheckFailedError } from "../../../../src/work/task-run/application/health-check-failed-error";

describe("buildTaskRunFailurePayload", () => {
  test("names an ordinary error Scarn.StepFailed, with the generic worker-execution-failed code", () => {
    const payload = buildTaskRunFailurePayload(new Error("boom"));

    expect(payload.errorJson).toEqual({
      name: "Scarn.StepFailed",
      code: "SCARN_WORKER_EXECUTION_FAILED",
      message: "boom",
    });
  });

  test("names a HealthCheckFailedError Scarn.HealthCheckFailed, with the dedicated health-check code", () => {
    const payload = buildTaskRunFailurePayload(
      new HealthCheckFailedError('Health check "greet" failed'),
    );

    expect(payload.errorJson).toEqual({
      name: "Scarn.HealthCheckFailed",
      code: "SCARN_HEALTH_CHECK_FAILED",
      message: 'Health check "greet" failed',
    });
  });
});

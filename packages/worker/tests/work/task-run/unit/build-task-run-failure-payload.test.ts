import { describe, expect, test } from "bun:test";
import {
  ConnectorMcpCollision,
  ConnectorVarsMissing,
} from "@scarn/sdk/connectors";
import { buildTaskRunFailurePayload } from "../../../../src/work/task-run/application/build-task-run-failure-payload";
import { ConnectorUnavailableError } from "../../../../src/work/task-run/application/connector-unavailable-error";
import { HealthCheckFailedError } from "../../../../src/work/task-run/application/health-check-failed-error";
import { NamedStepError } from "../../../../src/work/task-run/application/named-step-error";
import { RepoContextCommitUnavailableError } from "../../../../src/work/task-run/application/repo-context-commit-unavailable-error";
import { WorkerStoppedError } from "../../../../src/work/task-run/application/worker-stopped-error";

describe("buildTaskRunFailurePayload", () => {
  test("names connector failures by their codes", () => {
    expect(
      buildTaskRunFailurePayload(
        new ConnectorVarsMissing(undefined, [
          { connector: "datadog", vars: ["DD_API_KEY"] },
        ]),
      ).errorJson,
    ).toMatchObject({
      name: "Scarn.ConnectorVarsMissing",
      code: "SCARN_CONNECTOR_VARS_MISSING",
    });
    expect(
      buildTaskRunFailurePayload(new ConnectorMcpCollision(["datadog"]))
        .errorJson,
    ).toMatchObject({
      name: "Scarn.EnvironmentInvalid",
      code: "SCARN_ENVIRONMENT_INVALID",
    });
  });

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

  test("names a ConnectorUnavailableError Scarn.ConnectorUnavailable, listing each server", () => {
    const payload = buildTaskRunFailurePayload(
      new ConnectorUnavailableError([
        {
          name: "datadog",
          status: "failed",
          error: "401 Unauthorized",
          healthy: false,
        },
        { name: "playwright", status: "pending", healthy: false },
      ]),
    );

    expect(payload.errorJson).toEqual({
      name: "Scarn.ConnectorUnavailable",
      code: "SCARN_CONNECTOR_UNAVAILABLE",
      message:
        "MCP servers not connected: datadog (failed: 401 Unauthorized); playwright (pending)",
    });
  });

  test("names a RepoContextCommitUnavailableError with REPO_CONTEXT_COMMIT_UNAVAILABLE", () => {
    const error = new RepoContextCommitUnavailableError("abc123", "not found");

    const payload = buildTaskRunFailurePayload(error);

    expect(payload.errorJson).toEqual({
      name: "Scarn.RepoContextCommitUnavailable",
      code: "REPO_CONTEXT_COMMIT_UNAVAILABLE",
      message: error.message,
    });
  });

  test("names a WorkerStoppedError Scarn.WorkerStopped, with WORKER_STOPPED", () => {
    const error = new WorkerStoppedError("run-1");

    const payload = buildTaskRunFailurePayload(error);

    expect(payload.errorJson).toEqual({
      name: "Scarn.WorkerStopped",
      code: "WORKER_STOPPED",
      message: error.message,
    });
  });

  test("names a NamedStepError by the code step's error name and code", () => {
    const payload = buildTaskRunFailurePayload(
      new NamedStepError("Billing.Declined", "CARD_DECLINED", "declined"),
    );

    expect(payload.errorJson).toEqual({
      name: "Billing.Declined",
      code: "CARD_DECLINED",
      message: "declined",
    });
  });
});

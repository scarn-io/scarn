import { describe, expect, test } from "bun:test";
import type {
  EnvironmentRef,
  ResolvedEnvironmentRefInput,
} from "@scarn/sdk/environment";
import {
  planHealthCheckLaunches,
  type HealthCheckStep,
} from "../../../../src/work/task-run/application/plan-pipeline-health-check-launches";
import { buildWorkDryRunRuntimeInput } from "../../../../src/work/task-run/application/run-work-dry-run";
import { buildPipelineHealthCheckRuntimeInput } from "../../../../src/work/task-run/application/run-pipeline-health-checks-dry-run";

function step(
  key: string,
  environment: ResolvedEnvironmentRefInput,
): HealthCheckStep {
  return {
    stepDefinitionId: key,
    key,
    name: key,
    environment,
    opencodeMcpJson: null,
    healthChecksJson: [
      {
        kind: "tool",
        tool: "bash",
        args: { command: "true" },
        severity: "required",
        timeoutSeconds: 15,
      },
    ],
  };
}

describe("environment-ref health-check launch keys", () => {
  test("canonical object key ordering shares a launch", () => {
    const plan = planHealthCheckLaunches([
      step("a", {
        kind: "inline",
        runtime: { kind: "managed", id: "bun1" },
        envJson: [],
      }),
      step("b", {
        envJson: [],
        runtime: { id: "bun1", kind: "managed" },
        kind: "inline",
      }),
    ]);
    expect(plan.launches).toHaveLength(1);
    expect(plan.launches[0]?.steps.map((entry) => entry.key)).toEqual([
      "a",
      "b",
    ]);
  });

  test("null repo-default and an empty inline ref remain distinct", () => {
    expect(
      planHealthCheckLaunches([step("a", null), step("b", { kind: "inline" })])
        .launches,
    ).toHaveLength(2);
  });

  test("different vars do not merge even when their names do not conflict", () => {
    const value = (name: string) => ({
      name,
      source: "value" as const,
      value: "value",
      secret: false,
      applies: "agent" as const,
    });
    expect(
      planHealthCheckLaunches([
        step("a", { kind: "inline", envJson: [value("FIRST")] }),
        step("b", { kind: "inline", envJson: [value("SECOND")] }),
      ]).launches,
    ).toHaveLength(2);
  });

  test("MCP conflicts still split equal environment refs", () => {
    const first = step("a", null);
    const second = step("b", null);
    first.opencodeMcpJson = {
      api: { type: "remote", url: "https://one.example/mcp" },
    };
    second.opencodeMcpJson = {
      api: { type: "remote", url: "https://two.example/mcp" },
    };
    expect(planHealthCheckLaunches([first, second]).launches).toHaveLength(2);
  });

  test("named environments group by name@version", () => {
    const named = (name: string, version: number) => ({
      kind: "named" as const,
      name,
      version,
      content: { runtime: { kind: "host" as const } },
    });
    expect(
      planHealthCheckLaunches([
        step("a", named("local", 1)),
        step("b", named("local", 1)),
        step("c", named("ci", 1)),
        step("d", named("local", 2)),
      ]).launches.map((launch) => launch.steps.map((entry) => entry.key)),
    ).toEqual([["a", "b"], ["c"], ["d"]]);
  });

  test("steps naming a missing environment share one not-found launch", () => {
    const missing = {
      kind: "named" as const,
      name: "gone",
      notFound: true as const,
    };
    expect(
      planHealthCheckLaunches([step("a", missing), step("b", missing)])
        .launches,
    ).toHaveLength(1);
  });

  test("both dry-run builders forward whole refs, never flat selectors", () => {
    const environment: EnvironmentRef = {
      kind: "inline",
      runtime: { kind: "host" },
      envJson: [],
    };
    const repo = {
      mode: "readOnly" as const,
      gitCredentials: "none" as const,
      baseBranch: null,
    };
    expect(buildWorkDryRunRuntimeInput({ environment, repo })).toEqual({
      environment,
      repo,
    });
    expect(buildWorkDryRunRuntimeInput(null)).toEqual({
      environment: null,
      repo,
    });
    expect(buildPipelineHealthCheckRuntimeInput(environment)).toEqual({
      environment,
    });
    expect(buildPipelineHealthCheckRuntimeInput(null)).toEqual({
      environment: null,
    });
  });
});

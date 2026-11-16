import { describe, expect, test } from "bun:test";
import {
  describeHealthCheckRuntime,
  planHealthCheckLaunches,
  resolveHealthCheckRuntime,
  type HealthCheckStep,
} from "../../../../src/work/task-run/application/plan-pipeline-health-check-launches";

/**
 * The run-offer gate launches once per distinct runtime. Getting the grouping
 * wrong either wastes a container launch per step, or merges two steps whose
 * configurations disagree, and so tests a server one of them never gets.
 */

function step(
  overrides: Partial<HealthCheckStep> & { key: string },
): HealthCheckStep {
  return {
    stepDefinitionId: `id-${overrides.key}`,
    name: overrides.key,
    environment: null,
    opencodeMcpJson: null,
    healthChecksJson: [
      {
        kind: "cli",
        command: ["true"],
        expectExitCode: 0,
        severity: "required",
        timeoutSeconds: 15,
      },
    ],
    ...overrides,
  };
}

const keysPerLaunch = (steps: HealthCheckStep[]) =>
  planHealthCheckLaunches(steps).launches.map((launch) =>
    launch.steps.map((entry) => entry.key),
  );

describe("resolveHealthCheckRuntime", () => {
  test("an omitted runtime resolves to the repository default", () => {
    expect(resolveHealthCheckRuntime(step({ key: "default" }))).toBeNull();
  });

  test("an explicit pathless devcontainer retains its provenance", () => {
    expect(
      resolveHealthCheckRuntime(
        step({
          key: "dev",
          environment: { kind: "inline", runtime: { kind: "devcontainer" } },
        }),
      ),
    ).toEqual({ kind: "inline", runtime: { kind: "devcontainer" } });
  });

  test("an explicit host step resolves to host", () => {
    expect(
      resolveHealthCheckRuntime(
        step({
          key: "a",
          environment: { kind: "inline", runtime: { kind: "host" } },
        }),
      ),
    ).toEqual({ kind: "inline", runtime: { kind: "host" } });
  });

  test("an explicit managed runtime resolves its image", () => {
    expect(
      resolveHealthCheckRuntime(
        step({
          key: "a",
          environment: {
            kind: "inline",
            runtime: { kind: "managed", id: "node24" },
          },
        }),
      ),
    ).toEqual({ kind: "inline", runtime: { kind: "managed", id: "node24" } });
  });

  test("names each runtime for the report", () => {
    expect(describeHealthCheckRuntime(null)).toBe("repository default");
    expect(
      describeHealthCheckRuntime({ kind: "inline", runtime: { kind: "host" } }),
    ).toBe("host");
    expect(
      describeHealthCheckRuntime({
        kind: "inline",
        runtime: { kind: "devcontainer" },
      }),
    ).toBe("project devcontainer");
  });
});

describe("planHealthCheckLaunches", () => {
  test("repository defaults never share a launch with explicit pathless devcontainers", () => {
    const plan = planHealthCheckLaunches([
      step({ key: "default-1" }),
      step({
        key: "dev-1",
        environment: { kind: "inline", runtime: { kind: "devcontainer" } },
      }),
      step({ key: "default-2" }),
      step({
        key: "dev-2",
        environment: { kind: "inline", runtime: { kind: "devcontainer" } },
      }),
    ]);
    expect(plan.launches.map((launch) => launch.runtime)).toEqual([
      null,
      { kind: "inline", runtime: { kind: "devcontainer" } },
    ]);
    expect(
      plan.launches.map((launch) => launch.steps.map(({ key }) => key)),
    ).toEqual([
      ["default-1", "default-2"],
      ["dev-1", "dev-2"],
    ]);
  });

  test("steps with the same runtime share one launch, in pipeline order", () => {
    expect(
      keysPerLaunch([
        step({ key: "a" }),
        step({ key: "b" }),
        step({ key: "c" }),
      ]),
    ).toEqual([["a", "b", "c"]]);
  });

  test("one launch per distinct runtime", () => {
    expect(
      keysPerLaunch([
        step({
          key: "host-1",
          environment: { kind: "inline", runtime: { kind: "host" } },
        }),
        step({ key: "dev-1" }),
        step({
          key: "managed",
          environment: {
            kind: "inline",
            runtime: { kind: "managed", id: "node24" },
          },
        }),
        step({ key: "dev-2" }),
        step({
          key: "other-dev",
          environment: {
            kind: "inline",
            runtime: { kind: "devcontainer", config: ".devcontainer/b.json" },
          },
        }),
        step({
          key: "host-2",
          environment: { kind: "inline", runtime: { kind: "host" } },
        }),
      ]),
    ).toEqual([
      ["host-1", "host-2"],
      ["dev-1", "dev-2"],
      ["managed"],
      ["other-dev"],
    ]);
  });

  test("skips steps that declare no checks, and launches nothing for them", () => {
    const plan = planHealthCheckLaunches([
      step({
        key: "code",
        environment: { kind: "inline", runtime: { kind: "host" } },
        healthChecksJson: null,
      }),
      step({ key: "empty", healthChecksJson: [] }),
    ]);
    expect(plan.launches).toEqual([]);
    expect(plan.stepsWithoutChecks.map((entry) => entry.key)).toEqual([
      "code",
      "empty",
    ]);
  });

  test("merges MCP servers when the whole environment ref is shared", () => {
    const environment = {
      kind: "inline",
      envJson: [
        {
          name: "A",
          source: "inherit",
          from: "A",
          secret: false,
          optional: false,
          applies: "agent",
        },
      ],
    } as const;
    const [launch] = planHealthCheckLaunches([
      step({
        key: "a",
        opencodeMcpJson: { playwright: { type: "ref" } },
        environment: { ...environment, envJson: [...environment.envJson] },
      }),
      step({
        key: "b",
        environment: { ...environment, envJson: [...environment.envJson] },
        opencodeMcpJson: { playwright: { type: "ref" }, db: { type: "ref" } },
      }),
    ]).launches;
    expect(Object.keys(launch?.opencodeMcpJson ?? {})).toEqual([
      "playwright",
      "db",
    ]);
    expect(launch?.runtime).toEqual({
      ...environment,
      envJson: [...environment.envJson],
    });
  });

  test("an MCP key defined differently splits the steps into separate launches", () => {
    expect(
      keysPerLaunch([
        step({
          key: "a",
          opencodeMcpJson: { db: { type: "ref", name: "pg-readonly" } },
        }),
        step({
          key: "b",
          opencodeMcpJson: { db: { type: "ref", name: "pg-admin" } },
        }),
        step({
          key: "c",
          opencodeMcpJson: { db: { type: "ref", name: "pg-readonly" } },
        }),
      ]),
    ).toEqual([["a", "c"], ["b"]]);
  });

  test("key order inside a definition is not a conflict", () => {
    expect(
      keysPerLaunch([
        step({
          key: "a",
          opencodeMcpJson: { db: { type: "ref", name: "pg" } },
        }),
        step({
          key: "b",
          opencodeMcpJson: { db: { name: "pg", type: "ref" } },
        }),
      ]),
    ).toEqual([["a", "b"]]);
  });

  test("conflicting env specs also split", () => {
    expect(
      keysPerLaunch([
        step({
          key: "a",
          environment: {
            kind: "inline",
            envJson: [
              {
                name: "URL",
                source: "value",
                value: "x",
                secret: false,
                applies: "agent",
              },
            ],
          },
        }),
        step({
          key: "b",
          environment: {
            kind: "inline",
            envJson: [
              {
                name: "URL",
                source: "value",
                value: "y",
                secret: false,
                applies: "agent",
              },
            ],
          },
        }),
      ]),
    ).toEqual([["a"], ["b"]]);
  });

  test("steps with different rendered base branches launch separately", () => {
    const steps = [
      step({ key: "a", baseWorkBranch: "release" }),
      step({ key: "b" }),
      step({ key: "c", baseWorkBranch: "release" }),
    ];
    expect(keysPerLaunch(steps)).toEqual([["a", "c"], ["b"]]);
    expect(
      planHealthCheckLaunches(steps).launches.map(
        (launch) => launch.baseWorkBranch,
      ),
    ).toEqual(["release", null]);
  });
});

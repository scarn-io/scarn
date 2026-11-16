import { describe, expect, test } from "bun:test";
import type {
  EnvironmentRef,
  ResolvedEnvironment,
} from "@scarn/sdk/environment";
import { runInDryRunEnvironment } from "../../../../src/work/task-run/application/dry-run-environment";
import {
  buildPipelineHealthCheckRuntimeInput,
  runPipelineHealthCheckLaunches,
  type RunHealthCheckLaunch,
} from "../../../../src/work/task-run/application/run-pipeline-health-checks-dry-run";
import { listStepHealthCheckFindings } from "../../../../src/work/task-run/application/pipeline-health-check-report";
import {
  describeHealthCheckRuntime,
  planHealthCheckLaunches,
  type HealthCheckStep,
} from "../../../../src/work/task-run/application/plan-pipeline-health-check-launches";
import {
  fetchOncePerName,
  resolveStepEnvironmentRef,
  type FetchLatestEnvironment,
} from "../../../../src/work/task-run/application/resolve-step-environment-ref";
import { buildWorkDryRunScope } from "../../../../src/work/task-run/application/run-work-dry-run";
import {
  environmentLaunchFixture,
  namedEnvironment,
} from "./helpers/environment-launch-fixture";

/** Steps named `name`, with that environment's latest version fetched by `fetchLatest`. */
async function namedSteps(
  keys: string[],
  name: string,
  fetchLatest: FetchLatestEnvironment,
): Promise<HealthCheckStep[]> {
  return Promise.all(
    keys.map(async (key) => ({
      stepDefinitionId: `id-${key}`,
      key,
      name: key,
      environment: await resolveStepEnvironmentRef(
        { kind: "named", name },
        fetchLatest,
      ),
      opencodeMcpJson: null,
      healthChecksJson: [
        {
          kind: "cli" as const,
          command: ["true"],
          severity: "warn" as const,
          timeoutSeconds: 15,
          expectExitCode: 0,
        },
      ],
    })),
  );
}

describe("resolved dry-run reporting", () => {
  const fixture = environmentLaunchFixture(() => {});

  function launchThroughOrchestrator(
    setup: ReturnType<typeof fixture.setup>,
    counts: { probes: number; checks: number },
  ): RunHealthCheckLaunch {
    return async (launch) => {
      const outcome = await runInDryRunEnvironment({
        orchestrator: setup.orchestrator,
        launchInput: {
          ...setup.input,
          startAgent: true,
          ...buildPipelineHealthCheckRuntimeInput(launch.runtime),
        },
        keep: false,
        probe: () => {
          counts.probes++;
          return Promise.resolve({
            containerHealth: null,
            opencodeHealth: { healthy: true },
            mcpServers: [],
          });
        },
        run: () => {
          counts.checks++;
          return Promise.resolve(new Map());
        },
      });
      if (outcome.kind === "launch-failed") return outcome;
      return {
        kind: "ran",
        resolvedEnvironment: outcome.resolvedEnvironment,
        health: outcome.health,
        healthChecksByStep: outcome.result,
      };
    };
  }

  test("named steps launch the fetched latest version, once per name@version", async () => {
    await fixture.writeCanonical();
    await fixture.initRepo();
    const setup = fixture.setup();
    const counts = { probes: 0, checks: 0 };
    const fetched: string[] = [];
    const content = {
      runtime: {
        kind: "devcontainer",
        config: ".devcontainer/devcontainer.json",
      },
    } as const;
    const steps = await namedSteps(
      ["first", "second"],
      "local",
      fetchOncePerName((name) => {
        fetched.push(name);
        return Promise.resolve({ version: 4, content });
      }),
    );
    const result = await runPipelineHealthCheckLaunches({
      pipelineDefinitionId: "pipeline",
      steps,
      runLaunch: launchThroughOrchestrator(setup, counts),
    });
    expect(fetched).toEqual(["local"]);
    expect(result.launchCount).toBe(1);
    expect(counts).toEqual({ probes: 1, checks: 1 });
    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => step.runtime)).toEqual([
      "environment local (devcontainer .devcontainer/devcontainer.json)",
      "environment local (devcontainer .devcontainer/devcontainer.json)",
    ]);
  });

  test("a named environment fetched at different versions launches separately", () => {
    const step = (key: string, version: number): HealthCheckStep => ({
      stepDefinitionId: key,
      key,
      name: key,
      environment: namedEnvironment({ runtime: { kind: "host" } }, { version }),
      opencodeMcpJson: null,
      healthChecksJson: [
        {
          kind: "cli",
          command: ["true"],
          severity: "warn",
          timeoutSeconds: 15,
          expectExitCode: 0,
        },
      ],
    });
    expect(
      planHealthCheckLaunches([
        step("a", 1),
        step("b", 2),
        step("c", 1),
      ]).launches.map((launch) => launch.steps.map((entry) => entry.key)),
    ).toEqual([["a", "c"], ["b"]]);
  });

  test("a named step environment the project does not have blocks its steps before runtime startup", async () => {
    const name = "local";
    await fixture.initRepo();
    const setup = fixture.setup();
    const { deps, log } = setup;
    const counts = { probes: 0, checks: 0 };
    const result = await runPipelineHealthCheckLaunches({
      pipelineDefinitionId: "pipeline",
      steps: await namedSteps(["first", "second"], name, () =>
        Promise.resolve(null),
      ),
      runLaunch: launchThroughOrchestrator(setup, counts),
    });
    expect(result.ok).toBe(false);
    expect(result.launchCount).toBe(1);
    expect(log).toContain("clone");
    expect(deps.devcontainerLauncher.launchInputs).toEqual([]);
    expect(deps.opencodeBootstrap.startInputs).toEqual([]);
    expect(deps.payloadProvisioner.ensureCalls).toBe(0);
    expect(counts).toEqual({ probes: 0, checks: 0 });
    const findings = listStepHealthCheckFindings(result.steps);
    expect(findings).toHaveLength(2);
    for (const [index, key] of ["first", "second"].entries()) {
      expect(findings[index]).toMatchObject({
        stepKey: key,
        stepName: key,
        checkName: "environment",
        severity: "required",
        blocking: true,
        outcome: "failed",
      });
      expect(findings[index]?.message).toContain(
        `environment ${name} failed to launch`,
      );
      expect(findings[index]?.message).toContain(
        `Environment not found: ${name}`,
      );
    }
  });

  test.each<
    [
      NonNullable<Parameters<typeof namedEnvironment>[0]["runtime"]>,
      string,
      string,
    ]
  >([
    [
      { kind: "managed", id: "node24" },
      "environment local (managed runtime node24)",
      "managed",
    ],
    [
      { kind: "devcontainer", config: ".devcontainer/devcontainer.json" },
      "environment local (devcontainer .devcontainer/devcontainer.json)",
      "devcontainer",
    ],
  ])(
    "reports the actual named runtime from the shared post-clone launch: %j",
    async (runtime, description, kind) => {
      await fixture.writeCanonical();
      await fixture.initRepo();
      const { orchestrator, input } = fixture.setup();
      const outcome = await runInDryRunEnvironment({
        orchestrator,
        launchInput: {
          ...input,
          startAgent: true,
          environment: namedEnvironment({ runtime }),
        },
        keep: false,
        probe: () =>
          Promise.resolve({
            containerHealth: null,
            opencodeHealth: { healthy: true },
            mcpServers: [],
          }),
        run: () => Promise.resolve(null),
      });
      expect(outcome.kind).toBe("ran");
      if (outcome.kind !== "ran") throw new Error(outcome.reason);
      expect(
        describeHealthCheckRuntime(
          { kind: "named", name: "local" },
          outcome.resolvedEnvironment,
        ),
      ).toBe(description);
      expect(
        buildWorkDryRunScope(
          {
            id: "id",
            key: "review",
            name: "Review",
            environment: { kind: "named", name: "local" },
            repo: input.repo,
            resultSchemaJson: null,
            opencodeMcpJson: null,
            healthChecksJson: null,
          },
          outcome.resolvedEnvironment,
        ),
      ).toMatchObject({
        runtimeKind: kind,
        environmentSource: "named",
        environmentName: "local",
      });
      const report = await runPipelineHealthCheckLaunches({
        pipelineDefinitionId: "pipeline",
        steps: [
          {
            stepDefinitionId: "review",
            key: "review",
            name: "Review",
            environment: namedEnvironment({ runtime }),
            opencodeMcpJson: null,
            healthChecksJson: [
              {
                kind: "cli",
                command: ["true"],
                severity: "required",
                timeoutSeconds: 15,
                expectExitCode: 0,
              },
            ],
          },
        ],
        runLaunch: () =>
          Promise.resolve({
            kind: "ran",
            resolvedEnvironment: outcome.resolvedEnvironment,
            health: outcome.health,
            healthChecksByStep: new Map(),
          }),
      });
      expect(report.steps[0]?.runtime).toBe(description);
    },
  );

  test.each<[EnvironmentRef, ResolvedEnvironment, string]>([
    [
      null,
      {
        source: "repo-default",
        runtime: { kind: "managed", id: "bun1" },
        envVars: [],
        connectors: [],
      },
      "repository default (managed runtime bun1)",
    ],
    [
      { kind: "named", name: "local" },
      {
        source: "named",
        name: "local",
        runtime: { kind: "host" },
        envVars: [],
        connectors: [],
      },
      "environment local (host)",
    ],
    [
      { kind: "inline", runtime: { kind: "host" } },
      {
        source: "inline",
        runtime: { kind: "host" },
        envVars: [],
        connectors: [],
      },
      "host",
    ],
  ])(
    "keeps requested context while describing %p",
    (requested, resolved, expected) => {
      expect(describeHealthCheckRuntime(requested, resolved)).toBe(expected);
    },
  );
});

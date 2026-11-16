import { describe, expect, test } from "bun:test";
import {
  buildWorkDryRunRuntimeInput,
  buildWorkDryRunScope,
  type StepDefinitionForDryRun,
} from "../../../../src/work/task-run/application/run-work-dry-run";
import {
  fetchOncePerName,
  resolveStepEnvironmentRef,
} from "../../../../src/work/task-run/application/resolve-step-environment-ref";

describe("work dry-run runtime launch input", () => {
  test.each<
    [Exclude<StepDefinitionForDryRun["environment"], { kind: "named" }>]
  >([
    [null],
    [{ kind: "inline", runtime: { kind: "devcontainer" } }],
    [
      {
        kind: "inline",
        runtime: {
          kind: "devcontainer",
          config: ".devcontainer/alt/devcontainer.json",
        },
      },
    ],
    [{ kind: "inline", runtime: { kind: "host" } }],
    [{ kind: "inline", runtime: { kind: "managed", id: "bun1" } }],
  ])("preserves environment reference %p", (environment) => {
    const repo = {
      mode: "readOnly",
      gitCredentials: "none",
      baseBranch: null,
    } as const;

    expect(
      buildWorkDryRunRuntimeInput({
        environment,
        repo,
      }),
    ).toEqual({
      environment,
      repo,
    });
  });

  test("a named step environment launches its fetched latest version", async () => {
    const content = { runtime: { kind: "managed", id: "node24" } } as const;
    const environment = await resolveStepEnvironmentRef(
      { kind: "named", name: "ci" },
      (name) => Promise.resolve(name === "ci" ? { version: 3, content } : null),
    );
    expect(
      buildWorkDryRunRuntimeInput({
        environment,
        repo: {
          mode: "readOnly",
          gitCredentials: "none",
          baseBranch: null,
        },
      }).environment,
    ).toEqual({ kind: "named", name: "ci", version: 3, content });
  });

  test("a named step environment the project does not have launches as not found", async () => {
    expect(
      await resolveStepEnvironmentRef({ kind: "named", name: "gone" }, () =>
        Promise.resolve(null),
      ),
    ).toEqual({ kind: "named", name: "gone", notFound: true });
  });

  test("inline and repository-default refs are not fetched", async () => {
    const fetchLatest = () => {
      throw new Error("fetched");
    };
    expect(await resolveStepEnvironmentRef(null, fetchLatest)).toBeNull();
    expect(
      await resolveStepEnvironmentRef(
        { kind: "inline", runtime: { kind: "host" } },
        fetchLatest,
      ),
    ).toEqual({ kind: "inline", runtime: { kind: "host" } });
  });

  test("each environment name is fetched once however many steps use it", async () => {
    const fetched: string[] = [];
    const fetchLatest = fetchOncePerName((name) => {
      fetched.push(name);
      return Promise.resolve({ version: 1, content: {} });
    });
    await Promise.all(
      ["ci", "local", "ci", "ci"].map((name) =>
        resolveStepEnvironmentRef({ kind: "named", name }, fetchLatest),
      ),
    );
    expect(fetched).toEqual(["ci", "local"]);
  });

  test("global-only launch with no step is eligible for repo-default fallback", () => {
    expect(buildWorkDryRunRuntimeInput(null)).toEqual({
      environment: null,
      repo: {
        mode: "readOnly",
        gitCredentials: "none",
        baseBranch: null,
      },
    });
  });

  test("successful scope uses resolved runtime while retaining the named source", () => {
    const step: StepDefinitionForDryRun = {
      id: "id",
      key: "review",
      name: "Review",
      environment: { kind: "named", name: "ci" },
      repo: {
        mode: "readOnly",
        gitCredentials: "none",
        baseBranch: null,
      },
      resultSchemaJson: null,
      opencodeMcpJson: null,
      healthChecksJson: null,
    };
    expect(buildWorkDryRunScope(step)).toMatchObject({
      runtimeKind: null,
      environmentSource: "named",
      environmentName: "ci",
    });
    expect(
      buildWorkDryRunScope(step, {
        source: "named",
        name: "ci",
        runtime: { kind: "managed", id: "node24" },
        envVars: [],
        connectors: [],
      }),
    ).toMatchObject({
      runtimeKind: "managed",
      environmentSource: "named",
      environmentName: "ci",
    });
  });
});

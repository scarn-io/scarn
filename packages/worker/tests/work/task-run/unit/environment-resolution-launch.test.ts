import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  BrokenDevcontainerReference,
  EnvironmentNotFound,
  EnvironmentInvalid,
} from "@scarn/sdk/environment";
import { GitCliRepoContext } from "../../../../src/work/task-run/infra/git-cli-repo-context";
import { planStepEnv } from "../../../../src/work/task-run/application/resolve-step-env";
import {
  buildLaunchInput,
  rejectionOf,
} from "./helpers/orchestrator-launch-fakes";
import {
  environmentLaunchFixture,
  namedEnvironment,
} from "./helpers/environment-launch-fixture";

describe("post-checkout environment resolution", () => {
  let workspacePath: string;
  const { setup, writeCanonical, gitCommand, commitFile, initRepo } =
    environmentLaunchFixture((value) => {
      workspacePath = value;
    });

  test("discovers a config introduced by base branch checkout, not the cloned default", async () => {
    const { orchestrator, input, git, log } = setup();
    git.checkoutBase = async ({ baseWorkBranch }) => {
      expect(log).toEqual(["createWorkspace", "clone"]);
      expect(baseWorkBranch).toBe("previous-base");
      await writeCanonical();
      log.push("checkoutBase");
    };
    const launched = await orchestrator.launch({
      ...input,
      stepKey: "review",
      baseWorkBranch: "previous-base",
      environment: { kind: "inline" },
    });
    expect(launched.resolvedEnvironment.runtime).toEqual({
      kind: "devcontainer",
      config: ".devcontainer/devcontainer.json",
    });
    expect(log.indexOf("checkoutBase")).toBeLessThan(
      log.indexOf("resolveConfigPath"),
    );
  });

  for (const [kind, environment] of [
    ["inline", { kind: "inline" }],
    ["named", namedEnvironment({ runtime: { kind: "managed", id: "bun1" } })],
  ] as const) {
    for (const branches of [
      { baseWorkBranch: "previous", stepKey: "review", expected: "previous" },
      { baseWorkBranch: null, stepKey: "review", expected: "worker-base" },
      { baseWorkBranch: "rendered", stepKey: undefined, expected: "rendered" },
      { baseWorkBranch: null, stepKey: undefined, expected: "worker-base" },
    ]) {
      test(`${kind} branch precedence picks ${branches.expected} (${branches.stepKey ? "step run" : "dry run"})`, async () => {
        const { orchestrator, input, git } = setup();
        await orchestrator.launch({
          ...input,
          baseWorkBranch: branches.baseWorkBranch,
          stepKey: branches.stepKey,
          environment,
          localEnvVars: { SCARN_BASE_WORK_BRANCH: "worker-base" },
        });
        expect(git.checkoutBaseCalls).toEqual([branches.expected]);
      });
    }
  }

  test("resolves repo defaults afresh for each launch", async () => {
    const { orchestrator, input } = setup();
    const first = await orchestrator.launch(input);
    expect(first.resolvedEnvironment.runtime).toEqual({
      kind: "managed",
      id: "bun1",
    });
    await writeCanonical();
    const second = await orchestrator.launch({
      ...input,
      sessionId: buildLaunchInput().sessionId,
    });
    expect(second.resolvedEnvironment.runtime).toEqual({
      kind: "devcontainer",
      config: ".devcontainer/devcontainer.json",
    });
  });

  test("resolves vars after clone and masks secrets before setup output", async () => {
    const { orchestrator, input, deps, log } = setup();
    const secrets: string[] = [];
    const launch = deps.devcontainerLauncher.launch.bind(
      deps.devcontainerLauncher,
    );
    deps.devcontainerLauncher.launch = (launchInput) => {
      expect(secrets).toContain("private-value");
      expect(launchInput.hostEnv).toMatchObject({
        SETUP_TOKEN: "private-value",
      });
      return launch(launchInput);
    };
    await orchestrator.launch({
      ...input,
      environment: {
        kind: "inline",
        envJson: [
          {
            name: "SETUP_TOKEN",
            source: "inherit",
            from: "TOKEN",
            secret: true,
            optional: false,
            applies: "setup",
          },
          {
            name: "TITLE",
            source: "value",
            value: "{{input.title}}",
            secret: false,
            applies: "agent",
          },
        ],
      },
      onSecretValues: (values) => secrets.push(...values),
      resolveEnvironmentEnv: (environment) => {
        expect(log).toContain("clone");
        const plan = planStepEnv({
          envVars: environment.envVars,
          inputJson: { title: "resolved title" },
          workerEnv: { TOKEN: "private-value" },
          opencodeMcpJson: null,
        });
        expect(plan.resolved.stepEnv).toEqual({ TITLE: "resolved title" });
        expect(plan.resolved.promptEnv).toEqual({ TITLE: "resolved title" });
        return Promise.resolve(plan);
      },
    });
    expect(deps.opencodeBootstrap.startInputs).toEqual([]);
  });

  test("explicit pathless devcontainer is broken rather than managed fallback", async () => {
    const { orchestrator, input, deps } = setup();
    const error = await rejectionOf(
      orchestrator.launch({
        ...input,
        environment: { kind: "inline", runtime: { kind: "devcontainer" } },
      }),
    );
    expect(error).toBeInstanceOf(BrokenDevcontainerReference);
    expect(deps.devcontainerLauncher.launchInputs).toEqual([]);
  });

  test("launches historical inline HOME through the actual environment resolver callback", async () => {
    const { orchestrator, input, deps } = setup();
    let resolved = false;
    const launched = await orchestrator.launch({
      ...input,
      environment: {
        kind: "inline",
        envJson: [
          {
            name: "HOME",
            source: "value",
            value: "/historical/home",
            secret: false,
          },
        ],
      },
      resolveEnvironmentEnv: (environment) => {
        resolved = true;
        const plan = planStepEnv({
          envVars: environment.envVars,
          inputJson: {},
          workerEnv: {},
          opencodeMcpJson: null,
        });
        expect(plan.resolved.stepEnv).toEqual({ HOME: "/historical/home" });
        return Promise.resolve(plan);
      },
    });
    expect(resolved).toBe(true);
    expect(launched.resolvedEnvironment.envVars).toEqual([
      {
        name: "HOME",
        source: "value",
        value: "/historical/home",
        secret: false,
        applies: "agent",
      },
    ]);
    expect(deps.devcontainerLauncher.launchInputs).toHaveLength(1);
  });

  test("rejects a code host after clone and before starting any runtime", async () => {
    const { orchestrator, input, log, deps } = setup();
    const error = await rejectionOf(
      orchestrator.launch({
        ...input,
        taskKind: "code",
        stepKey: "host-code",
        environment: { kind: "inline", runtime: { kind: "host" } },
      }),
    );
    expect((error as Error).message).toContain(
      'Code step "host-code" cannot use the host runtime',
    );
    expect(log).toContain("clone");
    expect(deps.devcontainerLauncher.launchInputs).toEqual([]);
    expect(deps.opencodeBootstrap.startInputs).toEqual([]);
    expect(deps.workspaceManager.removeCalls).toEqual([workspacePath]);
  });

  test("takes a named environment from the run's context, not a committed environment file", async () => {
    await initRepo(
      '{"runtime":"host","repo":{"branch":"wrong"}}',
      ".scarn/environments/local.jsonc",
    );
    const { orchestrator, input } = setup();
    const launched = await orchestrator.launch({
      ...input,
      stepKey: "review",
      environment: namedEnvironment({
        runtime: { kind: "managed", id: "bun1" },
      }),
    });
    expect(launched.resolvedEnvironment).toMatchObject({
      source: "named",
      name: "local",
      runtime: { kind: "managed", id: "bun1" },
    });
  });

  test("a committed environment file never stands in for a name the project does not have", async () => {
    await initRepo('{"runtime":"host"}', ".scarn/environments/gone.jsonc");
    const { orchestrator, input, git, deps } = setup();
    const error = await rejectionOf(
      orchestrator.launch({
        ...input,
        environment: { kind: "named", name: "gone", notFound: true },
      }),
    );
    expect(error).toBeInstanceOf(EnvironmentNotFound);
    expect((error as EnvironmentNotFound).code).toBe(
      "SCARN_ENVIRONMENT_NOT_FOUND",
    );
    expect(git.checkoutBaseCalls).toEqual([]);
    expect(deps.devcontainerLauncher.launchInputs).toEqual([]);
  });

  test("named devcontainer discovery happens on the base branch", async () => {
    await initRepo();
    await gitCommand("checkout", "-b", "previous-base");
    await writeCanonical();
    await commitFile("devcontainer");
    await gitCommand("checkout", "main");
    const { orchestrator, input, git } = setup();
    git.checkoutBase = async ({ baseWorkBranch }) => {
      await gitCommand("checkout", baseWorkBranch);
    };
    const launched = await orchestrator.launch({
      ...input,
      stepKey: "review",
      baseWorkBranch: "previous-base",
      environment: namedEnvironment({}),
    });
    expect(launched.resolvedEnvironment.runtime).toEqual({
      kind: "devcontainer",
      config: ".devcontainer/devcontainer.json",
    });
  });

  test("a named continuation uses its pinned version and checks out its pinned commit", async () => {
    const pinned = await initRepo();
    await commitFile("moved on");
    await gitCommand("update-ref", "refs/remotes/origin/main", "HEAD");
    const { orchestrator, input, deps, git } = setup();
    const contextGit = new GitCliRepoContext();
    deps.repoContextGit.checkoutCommit = (input) =>
      contextGit.checkoutCommit(input);
    const launched = await orchestrator.launch({
      ...input,
      environment: namedEnvironment(
        { runtime: { kind: "managed", id: "bun1" } },
        { version: 3 },
      ),
      baseWorkBranch: "ignored",
      repoContext: {
        baseCommit: pinned,
        pinBaseCommit: () => {
          throw new Error("must not repin");
        },
      },
    });
    expect(launched.resolvedEnvironment).toMatchObject({
      runtime: { kind: "managed", id: "bun1" },
    });
    expect((await gitCommand("rev-parse", "HEAD")).trim()).toBe(pinned);
    expect(git.checkoutBaseCalls).toEqual([]);
  });

  for (const [workerBranch, configBranch, expected] of [
    ["worker-base", "config-base", "worker-base"],
    [undefined, "config-base", "config-base"],
    [undefined, undefined, undefined],
  ]) {
    test(`named without a branch falls back to ${expected ?? "default"}`, async () => {
      await mkdir(path.join(workspacePath, ".scarn"), { recursive: true });
      await writeFile(
        path.join(workspacePath, ".scarn/scarn.jsonc"),
        JSON.stringify({
          project: "acme/web-app",
          baseWorkBranch: configBranch,
        }),
      );
      const { orchestrator, input, git } = setup();
      await orchestrator.launch({
        ...input,
        stepKey: "review",
        environment: namedEnvironment({
          runtime: { kind: "managed", id: "bun1" },
        }),
        localEnvVars: workerBranch
          ? { SCARN_BASE_WORK_BRANCH: workerBranch }
          : {},
      });
      expect(git.checkoutBaseCalls).toEqual(expected ? [expected] : []);
    });
  }

  test("named host rejects code before starting any runtime", async () => {
    const { orchestrator, input, deps } = setup();
    const error = await rejectionOf(
      orchestrator.launch({
        ...input,
        taskKind: "code",
        environment: namedEnvironment({ runtime: { kind: "host" } }),
      }),
    );
    expect((error as Error).message).toContain("cannot use the host runtime");
    expect(deps.devcontainerLauncher.launchInputs).toEqual([]);
    expect(deps.opencodeBootstrap.startInputs).toEqual([]);
  });

  test("invalid named content fails before branch selection and names its version", async () => {
    const { orchestrator, input, git } = setup();
    const error = await rejectionOf(
      orchestrator.launch({
        ...input,
        environment: namedEnvironment(
          {
            runtime: { kind: "host" },
            vars: [
              {
                name: "TOKEN",
                source: "value",
                value: "",
                secret: false,
                applies: "setup",
              },
            ],
          },
          { version: 4 },
        ),
      }),
    );
    expect(error).toBeInstanceOf(EnvironmentInvalid);
    expect((error as Error).message).toContain("environment local v4");
    expect(git.checkoutBaseCalls).toEqual([]);
  });
});

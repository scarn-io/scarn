import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  BrokenDevcontainerReference,
  EnvironmentInvalid,
  EnvironmentNotFound,
} from "@scarn/sdk/environment";
import { buildTaskRunFailurePayload } from "../../../../src/work/task-run/application/build-task-run-failure-payload";
import { buildRunningMetadata } from "../../../../src/work/task-run/application/process-claimed-task-run-helpers";
import { markTrackedSessionRunning } from "../../../../src/work/task-run/application/process-claimed-task-run-tracker";
import { RepoBranchNotFoundError } from "../../../../src/work/task-run/application/repo-branch-not-found-error";
import { RepoBranchInvalidError } from "../../../../src/work/task-run/application/repo-branch-invalid-error";
import {
  MissingStepEnvError,
  planStepEnv,
} from "../../../../src/work/task-run/application/resolve-step-env";
import { ProjectSecretsRequestError } from "../../../../src/work/task-run/application/resolve-secret-env";
import { RepoContextCommitUnavailableError } from "../../../../src/work/task-run/application/repo-context-commit-unavailable-error";
import { GitCommandError } from "../../../../src/runtime/runtime-service/infra/git-failure";
import { GitCliCommitPushService } from "../../../../src/runtime/runtime-service/infra/git-cli-commit-push-service";
import { GitCliRepoContext } from "../../../../src/work/task-run/infra/git-cli-repo-context";
import { checkoutBaseBranch } from "../../../../src/work/task-run/infra/work-branch-manager";
import { setUpRepoContext } from "../../../../src/work/task-run/infra/repo-context-setup";
import { rethrowBranchFailure } from "../../../../src/work/task-run/infra/classify-branch-failure";
import {
  environmentLaunchFixture,
  namedEnvironment,
} from "./helpers/environment-launch-fixture";
import {
  buildLaunchInput,
  rejectionOf,
} from "./helpers/orchestrator-launch-fakes";

describe("environment failure identities", () => {
  for (const [error, code] of [
    [new EnvironmentNotFound("local"), "SCARN_ENVIRONMENT_NOT_FOUND"],
    [
      new EnvironmentInvalid("environment local v1", []),
      "SCARN_ENVIRONMENT_INVALID",
    ],
    [
      new BrokenDevcontainerReference(".devcontainer/missing.json"),
      "SCARN_DEVCONTAINER_REFERENCE_BROKEN",
    ],
    [new RepoBranchNotFoundError("gone"), "SCARN_REPO_BRANCH_NOT_FOUND"],
    [new RepoBranchInvalidError("bad"), "SCARN_REPO_BRANCH_INVALID"],
    [
      new MissingStepEnvError(["TOKEN", "SECOND_TOKEN"]),
      "SCARN_ENVIRONMENT_UNRESOLVED",
    ],
    [
      new ProjectSecretsRequestError(["DD_KEY"], { cause: new Error("409") }),
      "SCARN_ENVIRONMENT_UNRESOLVED",
    ],
  ] as const) {
    test(code, () => {
      expect(buildTaskRunFailurePayload(error).errorJson.code).toBe(code);
    });
  }

  test("does not trust arbitrary codes", () => {
    const error = Object.assign(new Error("spoofed"), {
      code: "SCARN_ENVIRONMENT_INVALID",
    });
    expect(buildTaskRunFailurePayload(error).errorJson.code).toBe(
      "SCARN_WORKER_EXECUTION_FAILED",
    );
  });

  for (const stderr of [
    "fatal: couldn't find remote ref gone",
    "fatal: couldn't find remote ref refs/heads/gone",
  ]) {
    test(`classifies explicit absence: ${stderr}`, () => {
      expect(() =>
        rethrowBranchFailure(new GitCommandError("fetch", stderr, 128), "gone"),
      ).toThrow(RepoBranchNotFoundError);
    });
  }

  for (const error of [
    new Error("couldn't find remote ref gone"),
    new GitCommandError(
      "timeout",
      "fatal: couldn't find remote ref gone",
      null,
    ),
    new GitCommandError(
      "network",
      "fatal: Could not resolve host: example",
      128,
    ),
    new GitCommandError("corrupt", "fatal: bad object origin/gone", 128),
    new GitCommandError(
      "mixed",
      "fatal: couldn't find remote ref gone\nfatal: bad object HEAD",
      128,
    ),
    new GitCommandError(
      "other ref",
      "fatal: couldn't find remote ref other",
      128,
    ),
    new RepoContextCommitUnavailableError("a".repeat(40), "unavailable"),
  ]) {
    test(`preserves unrelated failure: ${error.message}`, () => {
      try {
        rethrowBranchFailure(error, "gone");
      } catch (caught) {
        expect(caught).toBe(error);
      }
    });
  }
});

describe("launch environment diagnostics", () => {
  let workspacePath: string;
  const { setup, initRepo, commitFile, gitCommand } = environmentLaunchFixture(
    (value) => {
      workspacePath = value;
    },
  );
  const definition = namedEnvironment(
    {
      runtime: { kind: "managed", id: "bun1" },
      vars: [
        {
          name: "FIXED",
          source: "value",
          value: "fixed-private-value",
          secret: false,
        },
        {
          name: "TOKEN",
          source: "inherit",
          from: "WORKER_TOKEN",
          secret: true,
          optional: false,
        },
      ],
    },
    { version: 7 },
  );

  test("records the pinned version and checkout, and logs/persists names only", async () => {
    await initRepo();
    await gitCommand("checkout", "-b", "work");
    const checkout = await commitFile("work");
    const { orchestrator, input, deps } = setup();
    const readCommit = deps.readGitCommit;
    const reads: string[] = [];
    deps.readGitCommit = async (workspace, ref) => {
      reads.push(ref);
      return readCommit(workspace, ref);
    };
    const lines: string[] = [];
    const launched = await orchestrator.launch({
      ...input,
      environment: definition,
      logger: {
        log: (_scope, message) => lines.push(message),
        debug: () => {},
        error: () => {},
      },
      resolveEnvironmentEnv: (environment) =>
        Promise.resolve(
          planStepEnv({
            envVars: environment.envVars,
            inputJson: {},
            workerEnv: { WORKER_TOKEN: "worker-private-value" },
            opencodeMcpJson: null,
          }),
        ),
    });
    expect(reads).toEqual(["HEAD"]);
    expect(launched.environmentDiagnostics).toEqual({
      source: "named",
      name: "local",
      definitionVersion: { name: "local", version: 7 },
      checkoutCommit: checkout,
      runtime: { kind: "managed", id: "bun1" },
      branch: "main",
      branches: {
        template: null,
        base: "main",
        source: "remoteDefault",
        work: null,
        workMode: null,
      },
      vars: [
        { name: "FIXED", source: "value" },
        { name: "TOKEN", source: "worker" },
      ],
      connectors: [],
    });
    const metadata = buildRunningMetadata(launched);
    let trackedMetadata: string | null | undefined;
    await markTrackedSessionRunning(
      {
        createSession: () => {},
        markRunning: ({ metadataJson }) => {
          trackedMetadata = metadataJson;
        },
        attachAgentSession: () => {},
        markSucceeded: () => {},
        markFailed: () => {},
        close: () => {},
      },
      {
        ...launched,
        localRuntimeSessionId: buildLaunchInput().sessionId,
        agentBaseUrl: null,
      },
    );
    expect(trackedMetadata).toBe(metadata);
    expect(JSON.parse(metadata)).toMatchObject({
      resolvedBranch: launched.resolvedBranch,
      devcontainerConfigPath: launched.devcontainerConfigPath,
      aiImage: launched.aiImage,
      networkName: launched.networkName,
      environment: launched.environmentDiagnostics,
    });
    expect(
      lines.filter((line) => line.startsWith("Environment resolved:")),
    ).toEqual([
      `Environment resolved: ${JSON.stringify(launched.environmentDiagnostics)}`,
    ]);
    for (const value of ["fixed-private-value", "worker-private-value"]) {
      expect(metadata).not.toContain(value);
      expect(lines.join("\n")).not.toContain(value);
    }
  });

  test("inline and repo-default record code checkout and no definition version", async () => {
    const commit = await initRepo();
    const { orchestrator, input } = setup();
    for (const environment of [null, { kind: "inline" } as const]) {
      const launched = await orchestrator.launch({ ...input, environment });
      expect(launched.environmentDiagnostics).toMatchObject({
        source: environment?.kind ?? "repo-default",
        name: null,
        definitionVersion: null,
        checkoutCommit: commit,
      });
    }
  });

  test("continuation metadata records the pinned version and pinned checkout", async () => {
    const pinned = await initRepo();
    await commitFile("moved on");
    await gitCommand("update-ref", "refs/remotes/origin/main", "HEAD");
    const { orchestrator, input, deps } = setup();
    const git = new GitCliRepoContext();
    deps.repoContextGit.checkoutCommit = (input) => git.checkoutCommit(input);
    const launched = await orchestrator.launch({
      ...input,
      environment: definition,
      repoContext: {
        baseCommit: pinned,
        pinBaseCommit: () => {
          throw new Error("must not repin");
        },
      },
    });
    expect(launched.environmentDiagnostics).toMatchObject({
      definitionVersion: { name: "local", version: 7 },
      checkoutCommit: pinned,
      branch: pinned,
      branches: null,
      runtime: { kind: "managed", id: "bun1" },
    });
  });

  test("missing vars list every worker name and the env file without exposing fixed or worker values", async () => {
    const inherit = (name: string, from: string) => ({
      name,
      source: "inherit" as const,
      from,
      secret: false,
      optional: false,
    });
    const { orchestrator, input } = setup();
    const lines: string[] = [];
    const error = await rejectionOf(
      orchestrator.launch({
        ...input,
        environment: namedEnvironment({
          runtime: { kind: "managed", id: "bun1" },
          vars: [
            {
              name: "FIXED",
              source: "value",
              value: "fixed-private-value",
              secret: false,
            },
            inherit("PRESENT", "WORKER_PRESENT"),
            inherit("ONE", "WORKER_ONE"),
            inherit("TWO", "WORKER_TWO"),
          ],
        }),
        logger: {
          log: (_scope, message) => lines.push(message),
          debug: () => {},
          error: () => {},
        },
        resolveEnvironmentEnv: (environment) =>
          Promise.resolve(
            planStepEnv({
              envVars: environment.envVars,
              inputJson: {},
              workerEnv: { WORKER_PRESENT: "worker-private-value" },
              opencodeMcpJson: null,
            }),
          ),
      }),
    );
    expect(error).toBeInstanceOf(MissingStepEnvError);
    const payload = buildTaskRunFailurePayload(error as Error);
    expect(payload.errorJson.code).toBe("SCARN_ENVIRONMENT_UNRESOLVED");
    for (const name of ["WORKER_ONE", "WORKER_TWO", ".scarn/.env"]) {
      expect(payload.errorJson.message).toContain(name);
    }
    for (const value of ["fixed-private-value", "worker-private-value"]) {
      expect(JSON.stringify(payload)).not.toContain(value);
      expect(lines.join("\n")).not.toContain(value);
    }
  });

  test("real checkout fetch and initial conversation pin classify missing branches", async () => {
    await initRepo();
    await gitCommand("remote", "add", "origin", workspacePath);
    const checkoutError = await rejectionOf(
      checkoutBaseBranch({
        gitCommitPushService: new GitCliCommitPushService(),
        workspacePath,
        resolvedBranch: "main",
        baseWorkBranch: "gone",
      }),
    );
    expect(checkoutError).toBeInstanceOf(RepoBranchNotFoundError);
    await mkdir(path.join(workspacePath, ".scarn"), { recursive: true });
    await writeFile(
      path.join(workspacePath, ".scarn/scarn.jsonc"),
      JSON.stringify({ project: "acme/web-app", baseWorkBranch: "gone" }),
    );
    const pinError = await rejectionOf(
      setUpRepoContext({
        workspacePath,
        resolvedBranch: "main",
        repoContextGit: new GitCliRepoContext(),
        repoContext: {
          baseCommit: null,
          pinBaseCommit: ({ baseCommit }) => Promise.resolve(baseCommit),
        },
      }),
    );
    expect(pinError).toBeInstanceOf(RepoBranchNotFoundError);
  });

  test("invalid definition failures never embed the definition's fixed or worker values", async () => {
    const { orchestrator, input } = setup();
    const error = await rejectionOf(
      orchestrator.launch({
        ...input,
        environment: namedEnvironment({
          runtime: { kind: "host" },
          vars: [
            {
              name: "FIXED",
              source: "value",
              value: "fixed-private-value",
              secret: false,
              applies: "setup",
            },
            {
              name: "TOKEN",
              source: "inherit",
              from: "TOKEN",
              secret: false,
              optional: false,
              default: "worker-private-value",
              applies: "both",
            },
          ],
        }),
      }),
    );
    expect(error).toBeInstanceOf(EnvironmentInvalid);
    const message = buildTaskRunFailurePayload(error as Error).errorJson
      .message;
    expect(message).not.toContain("fixed-private-value");
    expect(message).not.toContain("worker-private-value");
  });
});

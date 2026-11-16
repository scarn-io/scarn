/**
 * A step's `baseBranch` at launch: rendered before checkout, then ordered
 * after the server's `baseWorkBranch` and before the worker's configured base
 * (ADR 0010), with the winning rule recorded in the environment diagnostics.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RepoConfig } from "@scarn/sdk/repo-config";
import { createUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { GitCommandError } from "../../../../src/runtime/runtime-service/infra/git-failure";
import { MissingStepEnvError } from "../../../../src/work/task-run/application/resolve-step-env";
import { RepoBranchInvalidError } from "../../../../src/work/task-run/application/repo-branch-invalid-error";
import { RepoBranchNotFoundError } from "../../../../src/work/task-run/application/repo-branch-not-found-error";
import { DefaultLocalProjectRuntimeEnvironmentOrchestrator } from "../../../../src/work/task-run/infra/local-project-runtime-environment";
import {
  buildLaunchInput,
  buildOrchestratorFakeDeps,
  FakeGitCommitPushService,
  FakeSubmoduleService,
  rejectionOf,
  type CallLog,
} from "./helpers/orchestrator-launch-fakes";

const ticketEnvironment = {
  kind: "inline" as const,
  envJson: [
    {
      name: "TICKET_NUMBER",
      source: "inherit" as const,
      from: "TICKET_NUMBER",
      secret: false,
      optional: false,
    },
  ],
};

function readWrite(
  baseBranch: string | null,
  workBranch: "create" | "base" = "create",
): RepoConfig {
  return {
    mode: "readWrite",
    message: null,
    onPushFailure: "fail",
    gitCredentials: "none",
    baseBranch,
    workBranch: { kind: workBranch },
  };
}

describe("step baseBranch at launch", () => {
  let workspacePath: string;
  let providerOutputDir: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), "orchestrator-ws-"));
    providerOutputDir = await mkdtemp(
      path.join(os.tmpdir(), "orchestrator-provider-"),
    );
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
    await rm(providerOutputDir, { recursive: true, force: true });
  });

  function setup(submoduleService?: FakeSubmoduleService) {
    const log: CallLog = [];
    const commitPush = new FakeGitCommitPushService(log);
    const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      buildOrchestratorFakeDeps({
        workspacePath,
        providerOutputDir,
        log,
        gitCommitPushService: commitPush,
        submoduleService,
      }),
    );
    const taskRunId = createUuidV7();
    const input = {
      ...buildLaunchInput(),
      stepKey: "impl",
      currentExecutionInfo: {
        taskRunId,
        resultSchemaJson: null,
        turnsRemaining: null,
      },
    };
    return { orchestrator, commitPush, input, taskRunId };
  }

  test("ephemeral-{{env.TICKET_NUMBER}} checks out ephemeral-1234 and create branches from it", async () => {
    const { orchestrator, commitPush, input, taskRunId } = setup();
    const template = "ephemeral-{{env.TICKET_NUMBER}}";
    const env = await orchestrator.launch({
      ...input,
      environment: ticketEnvironment,
      repo: readWrite(template),
      localEnvVars: { TICKET_NUMBER: "1234" },
    });
    const workBranch = `scarn/impl-${taskRunId}`;
    expect(commitPush.checkoutBaseCalls).toEqual(["ephemeral-1234"]);
    expect(commitPush.createBranchCalls).toEqual([workBranch]);
    expect(env.createdFromBranch).toBe("ephemeral-1234");
    expect(env.environmentDiagnostics?.branches).toEqual({
      template,
      base: "ephemeral-1234",
      source: "step",
      work: workBranch,
      workMode: "create",
    });
  });

  test("the server's branch (a continued run) beats baseBranch", async () => {
    const { orchestrator, commitPush, input } = setup();
    const env = await orchestrator.launch({
      ...input,
      repo: readWrite("release"),
      baseWorkBranch: "scarn/plan-1",
    });
    expect(commitPush.checkoutBaseCalls).toEqual(["scarn/plan-1"]);
    expect(env.environmentDiagnostics?.branches).toMatchObject({
      base: "scarn/plan-1",
      source: "server",
    });
  });

  test("baseBranch wins when the server sends no branch (it omits the previous step's when baseBranch is set)", async () => {
    const { orchestrator, commitPush, input } = setup();
    const env = await orchestrator.launch({
      ...input,
      repo: readWrite("release"),
      baseWorkBranch: null,
    });
    expect(commitPush.checkoutBaseCalls).toEqual(["release"]);
    expect(env.environmentDiagnostics?.branches).toMatchObject({
      base: "release",
      source: "step",
    });
  });

  test("renders {{input.…}} and {{workItem.platformKey}}", async () => {
    const { orchestrator, commitPush, input } = setup();
    await orchestrator.launch({
      ...input,
      repo: readWrite("{{workItem.platformKey}}/{{input.version}}"),
      stepInputJson: { version: "v2" },
      loadCommitWorkItem: () =>
        Promise.resolve({ title: "Fix", platformKey: "ABC-123" }),
    });
    expect(commitPush.checkoutBaseCalls).toEqual(["ABC-123/v2"]);
  });

  for (const [label, localEnvVars, config, expected] of [
    [
      "worker",
      { SCARN_BASE_WORK_BRANCH: "worker-base" },
      "config-base",
      "worker-base",
    ],
    ["project", {}, "config-base", "config-base"],
    ["remoteDefault", {}, undefined, "main"],
  ] as const) {
    test(`with no baseBranch the ${label} rule wins`, async () => {
      await mkdir(path.join(workspacePath, ".scarn"), { recursive: true });
      await writeFile(
        path.join(workspacePath, ".scarn/scarn.jsonc"),
        JSON.stringify({ project: "acme/web-app", baseWorkBranch: config }),
      );
      const { orchestrator, input } = setup();
      const env = await orchestrator.launch({
        ...input,
        repo: {
          mode: "readOnly",
          gitCredentials: "none",
          baseBranch: null,
        },
        localEnvVars,
      });
      expect(env.environmentDiagnostics?.branches).toEqual({
        template: null,
        base: expected,
        source: label,
        work: null,
        workMode: null,
      });
    });
  }

  test("a baseBranch beats the worker's configured base", async () => {
    const { orchestrator, commitPush, input } = setup();
    await orchestrator.launch({
      ...input,
      repo: readWrite("release"),
      localEnvVars: { SCARN_BASE_WORK_BRANCH: "worker-base" },
    });
    expect(commitPush.checkoutBaseCalls).toEqual(["release"]);
  });

  test("a missing var fails before checkout", async () => {
    const { orchestrator, commitPush, input } = setup();
    const error = await rejectionOf(
      orchestrator.launch({
        ...input,
        environment: ticketEnvironment,
        repo: readWrite("ephemeral-{{env.TICKET_NUMBER}}"),
        localEnvVars: {},
      }),
    );
    expect(error).toBeInstanceOf(MissingStepEnvError);
    expect((error as Error).message).toContain("TICKET_NUMBER");
    expect(commitPush.checkoutBaseCalls).toEqual([]);
  });

  for (const [label, template, stepInputJson] of [
    ["an empty render", "b/{{input.ticket}}", { ticket: "" }],
    ["a ..", "{{input.ticket}}", { ticket: "a..b" }],
  ] as const) {
    test(`${label} fails with RepoBranchInvalid before checkout`, async () => {
      const { orchestrator, commitPush, input } = setup();
      const error = await rejectionOf(
        orchestrator.launch({
          ...input,
          repo: readWrite(template),
          stepInputJson,
        }),
      );
      expect(error).toBeInstanceOf(RepoBranchInvalidError);
      expect(commitPush.checkoutBaseCalls).toEqual([]);
    });
  }

  test("a branch missing on origin fails with RepoBranchNotFound", async () => {
    const { orchestrator, commitPush, input } = setup();
    commitPush.checkoutBase = () =>
      Promise.reject(
        new GitCommandError(
          "fetch",
          "fatal: couldn't find remote ref ephemeral-9",
          128,
        ),
      );
    const error = await rejectionOf(
      orchestrator.launch({
        ...input,
        repo: readWrite("ephemeral-{{input.n}}"),
        stepInputJson: { n: 9 },
      }),
    );
    expect(error).toBeInstanceOf(RepoBranchNotFoundError);
    expect((error as RepoBranchNotFoundError).branch).toBe("ephemeral-9");
  });

  describe("WorkBranch.base()", () => {
    test("commits onto the rendered base and records it as both branches", async () => {
      const submodules = new FakeSubmoduleService([
        { path: "vendor/dep", initialized: true },
      ]);
      const { orchestrator, commitPush, input, taskRunId } = setup(submodules);
      commitPush.submoduleHasChanges = () => Promise.resolve(true);
      const submoduleBranches: string[] = [];
      commitPush.commitInSubmodule = (commit) => {
        submoduleBranches.push(commit.branchName);
        return Promise.resolve({ committed: true, branchCreated: true });
      };
      const template = "ephemeral-{{env.TICKET_NUMBER}}";
      const env = await orchestrator.launch({
        ...input,
        environment: ticketEnvironment,
        repo: readWrite(template, "base"),
        localEnvVars: { TICKET_NUMBER: "1234" },
      });

      expect(commitPush.checkoutBaseCalls).toEqual(["ephemeral-1234"]);
      expect(commitPush.createBranchCalls).toEqual([]);
      expect(env.workBranch).toBe("ephemeral-1234");
      expect(env.createdFromBranch).toBe("ephemeral-1234");
      expect(env.environmentDiagnostics?.branches).toEqual({
        template,
        base: "ephemeral-1234",
        source: "step",
        work: "ephemeral-1234",
        workMode: "base",
      });

      await env.commitAndPushWorkBranch?.({ result: {} });
      expect(commitPush.pushCalls).toEqual(["ephemeral-1234"]);
      expect(submoduleBranches).toEqual([`scarn/impl-${taskRunId}`]);
    });

    test("commits onto the previous step's branch", async () => {
      const { orchestrator, commitPush, input } = setup();
      const env = await orchestrator.launch({
        ...input,
        repo: readWrite(null, "base"),
        baseWorkBranch: "ephemeral-1234",
      });
      expect(commitPush.createBranchCalls).toEqual([]);
      expect(env.workBranch).toBe("ephemeral-1234");
      expect(env.environmentDiagnostics?.branches).toMatchObject({
        source: "server",
        workMode: "base",
      });
    });

    for (const [label, localEnvVars] of [
      ["the worker's base", { SCARN_BASE_WORK_BRANCH: "worker-base" }],
      ["the remote default", {}],
    ] as const) {
      test(`with no explicit base, ${label} fails with RepoBranchInvalid`, async () => {
        const { orchestrator, commitPush, input } = setup();
        const error = await rejectionOf(
          orchestrator.launch({
            ...input,
            repo: readWrite(null, "base"),
            localEnvVars,
          }),
        );
        expect(error).toBeInstanceOf(RepoBranchInvalidError);
        expect(commitPush.checkoutBaseCalls).toEqual([]);
      });
    }
  });
});

/**
 * A step's `baseBranch` and `workBranch` on the fake remote (ADR 0010), through
 * the real `scarn work` path: a templated base rendered from the step's
 * environment and checked out, a `WorkBranch.create()` step branching off it,
 * a `WorkBranch.base()` step committing onto it, and a `WorkBranch.base()`
 * push rejected because origin moved meanwhile.
 *
 * Split from `work-command-runtime.integration.test.ts` (same harness, same
 * gating); run with:
 *   SCARN_INTEGRATION=true bun test tests/work/task-run/integration
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RepoConfigInput } from "@scarn/sdk/repo-config";
import { createUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { runProjectWork } from "../../../../src/work/task-run/application/run-project-work";
import {
  buildIntegrationDeps,
  type IntegrationDeps,
} from "./helpers/build-integration-deps";
import { FakeTaskRunWorkerClient } from "./helpers/fake-worker-client";
import { buildSingleStepScenario } from "./helpers/scenario";

const execFileAsync = promisify(execFile);

const integrationEnabled = process.env["SCARN_INTEGRATION"] === "true";
const keepContainers =
  process.env["SCARN_INTEGRATION_KEEP_CONTAINERS"] === "true";
const TEST_TIMEOUT_MS = 3 * 60 * 1000;
const BASE = "ephemeral-1234";
const TEMPLATE = "ephemeral-{{env.TICKET_NUMBER}}";
const WRITING_CODE_STEP_ENTRYPOINT = {
  sourceFile: ".scarn/pipeline-builder/integration-writing-code-step.mjs",
};
const ticketEnvironment = {
  kind: "inline" as const,
  envJson: [
    {
      name: "TICKET_NUMBER",
      source: "inherit" as const,
      from: "TICKET_NUMBER",
      secret: false,
      optional: false,
      applies: "agent" as const,
    },
  ],
};

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

describe.skipIf(!integrationEnabled)("step base branch (integration)", () => {
  let homeDir: string;
  let originalHome: string | undefined;
  let built: IntegrationDeps | undefined;

  beforeEach(async () => {
    process.env["TESTCONTAINERS_RYUK_DISABLED"] ??= "true";
    homeDir = await mkdtemp(path.join(os.tmpdir(), "scarn-base-branch-it-"));
    originalHome = process.env["HOME"];
    process.env["HOME"] = homeDir;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    if (!keepContainers) {
      await built?.containerRegistry.stopAll();
      await rm(homeDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    built = undefined;
  });

  /**
   * Runs one writing code step on a remote that also holds `BASE` (one commit
   * past `main`). `beforePush` runs right before the work-branch push.
   */
  async function run(
    repo: RepoConfigInput,
    beforePush?: (remoteDir: string) => Promise<void>,
  ) {
    const scenario = buildSingleStepScenario({
      projectId: createUuidV7(),
      taskRunId: createUuidV7(),
      findings: {},
      codeEntrypoint: WRITING_CODE_STEP_ENTRYPOINT,
      environment: ticketEnvironment,
      repo,
    });
    const workerClient = new FakeTaskRunWorkerClient(scenario);
    let baseTip = "";
    const integration = buildIntegrationDeps({
      workerClient,
      verbose: process.env["SCARN_INTEGRATION_VERBOSE"] === "true",
      afterClone: async (workspace) => {
        if (baseTip) return;
        await git(workspace, ["checkout", "-b", BASE]);
        await writeFile(path.join(workspace, "base.txt"), "base\n");
        await git(workspace, ["add", "base.txt"]);
        await git(workspace, ["commit", "--no-gpg-sign", "-m", "base commit"]);
        await git(workspace, ["push", "origin", BASE]);
        baseTip = await git(workspace, ["rev-parse", "HEAD"]);
        await git(workspace, ["checkout", "main"]);
      },
    });
    built = integration;
    if (beforePush) {
      const service = integration.gitCommitPushService;
      const push = service.push.bind(service);
      service.push = async (input) => {
        await beforePush(integration.remote.dir);
        return push(input);
      };
    }

    const result = await runProjectWork(
      {
        projectId: scenario.projectId,
        baseUrl: "http://127.0.0.1:1",
        concurrency: 1,
        batchSize: 1,
        pollIntervalMs: 250,
        missingFindingsGraceMs: 5_000,
        leaseDurationSeconds: 60,
        once: true,
        sessionStartTimeoutMs: 60_000,
        preserveRuntimeOnComplete: keepContainers,
        readLocalEnv: () => Promise.resolve({ TICKET_NUMBER: "1234" }),
      },
      integration.deps,
    );
    expect(result.claimedCount).toBe(1);
    const taskRunId = scenario.steps[0]?.taskRunId ?? "";
    return { workerClient, integration, taskRunId, baseTip: () => baseTip };
  }

  test(
    "a templated baseBranch is rendered from the step's environment and WorkBranch.create() branches off it",
    async () => {
      const { workerClient, integration, taskRunId, baseTip } = await run({
        mode: "readWrite",
        baseBranch: TEMPLATE,
      });

      expect(workerClient.failCalls).toHaveLength(0);
      expect(workerClient.completeCalls).toHaveLength(1);
      const workBranch = `scarn/integration-step-${taskRunId}`;
      expect(workerClient.completeCalls[0]?.workBranch).toBe(workBranch);
      expect(workerClient.completeCalls[0]?.createdFromBranch).toBe(BASE);
      const remote = integration.remote.dir;
      expect(await git(remote, ["rev-parse", `${workBranch}^`])).toBe(
        baseTip(),
      );
      expect(await git(remote, ["rev-parse", BASE])).toBe(baseTip());
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "WorkBranch.base() commits onto the templated base and pushes it",
    async () => {
      const { workerClient, integration, taskRunId, baseTip } = await run({
        mode: "readWrite",
        baseBranch: TEMPLATE,
        workBranch: { kind: "base" },
      });

      expect(workerClient.failCalls).toHaveLength(0);
      expect(workerClient.completeCalls).toHaveLength(1);
      expect(workerClient.completeCalls[0]?.workBranch).toBe(BASE);
      expect(workerClient.completeCalls[0]?.createdFromBranch).toBe(BASE);
      const remote = integration.remote.dir;
      expect(await integration.remote.branches()).toEqual([BASE, "main"]);
      expect(await git(remote, ["rev-parse", `${BASE}^`])).toBe(baseTip());
      expect(await integration.remote.commitSubject(BASE)).toBe(
        `scarn: task ${taskRunId}`,
      );
      expect(await git(remote, ["show", `${BASE}:generated.txt`])).toBe(
        "generated by the integration code step",
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "WorkBranch.base(): a commit pushed to origin meanwhile fails the step without forcing",
    async () => {
      let racingTip = "";
      const { workerClient, integration } = await run(
        {
          mode: "readWrite",
          baseBranch: TEMPLATE,
          workBranch: { kind: "base" },
        },
        async (remoteDir) => {
          const other = await mkdtemp(path.join(os.tmpdir(), "scarn-race-"));
          try {
            await execFileAsync("git", ["clone", "-b", BASE, remoteDir, other]);
            await writeFile(path.join(other, "race.txt"), "race\n");
            await git(other, ["add", "race.txt"]);
            await git(other, [
              "-c",
              "user.name=Racer",
              "-c",
              "user.email=racer@scarn.io",
              "commit",
              "--no-gpg-sign",
              "-m",
              "racing commit",
            ]);
            await git(other, ["push", "origin", BASE]);
            racingTip = await git(other, ["rev-parse", "HEAD"]);
          } finally {
            await rm(other, { recursive: true, force: true });
          }
        },
      );

      expect(workerClient.completeCalls).toHaveLength(0);
      expect(workerClient.failCalls).toHaveLength(1);
      const message = (
        workerClient.failCalls[0]?.errorJson as { message: string }
      ).message;
      expect(message).toContain(`Failed to push work branch "${BASE}"`);
      expect(message).toContain("origin moved; not forced");
      expect(await git(integration.remote.dir, ["rev-parse", BASE])).toBe(
        racingTip,
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "WorkBranch.base() with no explicit base fails with RepoBranchInvalid before any container launches",
    async () => {
      const { workerClient, integration } = await run({
        mode: "readWrite",
        workBranch: { kind: "base" },
      });

      expect(workerClient.completeCalls).toHaveLength(0);
      expect(workerClient.failCalls).toHaveLength(1);
      const errorJson = JSON.stringify(workerClient.failCalls[0]?.errorJson);
      expect(errorJson).toContain("SCARN_REPO_BRANCH_INVALID");
      expect(integration.devcontainerLauncher.launchedConfigPaths).toEqual([]);
      expect(await integration.remote.branches()).toEqual([BASE, "main"]);
    },
    TEST_TIMEOUT_MS,
  );
});

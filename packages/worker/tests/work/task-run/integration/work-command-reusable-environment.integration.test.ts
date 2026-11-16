/**
 * Isolated worker/Git/container flow, not CLI/server E2E. Platform responses
 * are fake (including each named environment version); dotenv loading,
 * orchestration and code execution are real.
 * The launcher does not execute onCreateCommand or install dependencies.
 */
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { codeStep, Repo } from "@scarn/sdk/definitions/steps";
import type { ResolvedEnvironmentRef } from "@scarn/sdk/environment";
import { createUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { readLocalEnvVars } from "../../../../src/project/local-env/read-local-env-vars";
import { runGit } from "../../../../src/runtime/runtime-service/infra/run-git";
import { runProjectWork } from "../../../../src/work/task-run/application/run-project-work";
import {
  buildIntegrationDeps,
  type IntegrationDeps,
} from "./helpers/build-integration-deps";
import { FakeTaskRunWorkerClient } from "./helpers/fake-worker-client";
import { buildSingleStepScenario } from "./helpers/scenario";

const enabled = process.env["SCARN_INTEGRATION"] === "true";
const keep = process.env["SCARN_INTEGRATION_KEEP_CONTAINERS"] === "true";
const staleDefinitionPath = ".scarn/environments/e2e.jsonc";
const probePath =
  ".scarn/pipeline-builder/integration-runtime-probe-code-step.mjs";

describe.skipIf(!enabled)("reusable environments isolated runtime flow", () => {
  let directory: string;
  let source: string;
  let workerProject: string;
  let originalHome: string | undefined;
  const integrations: IntegrationDeps[] = [];

  beforeEach(async () => {
    process.env["TESTCONTAINERS_RYUK_DISABLED"] ??= "true";
    directory = await mkdtemp(path.join(os.tmpdir(), "scarn-reusable-env-it-"));
    originalHome = process.env["HOME"];
    process.env["HOME"] = path.join(directory, "home");
    await mkdir(process.env["HOME"], { recursive: true });
    source = path.join(directory, "source");
    workerProject = path.join(directory, "worker");
    await cp(new URL("./helpers/dummy-repo/", import.meta.url), source, {
      recursive: true,
    });
    await rm(path.join(source, ".devcontainer"), {
      recursive: true,
      force: true,
    });
    await rm(path.join(source, "devcontainer.json"), { force: true });
    await mkdir(path.join(workerProject, ".scarn"), { recursive: true });
    await writeFile(
      path.join(source, ".gitignore"),
      "node_modules/\n.scarn/.env\n",
    );
    await git("init", "-b", "main");
    await git("config", "user.email", "integration@scarn.io");
    await git("config", "user.name", "Scarn Integration");
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    if (!keep) {
      for (const built of integrations) await built.containerRegistry.stopAll();
      await rm(directory, { recursive: true, force: true });
    }
    integrations.length = 0;
  });

  function git(...args: string[]) {
    return runGit(["-C", source, ...args], {
      label: "reusable environment fixture",
      timeoutMs: 10_000,
    });
  }

  async function commit(message: string) {
    await git("add", "-A");
    await git("commit", "--no-gpg-sign", "-m", message);
    return (await git("rev-parse", "HEAD")).trim();
  }

  function e2eVersion(version: number, value: string): ResolvedEnvironmentRef {
    return {
      kind: "named",
      name: "e2e",
      version,
      content: {
        runtime: { kind: "managed", id: "bun1" },
        vars: [
          {
            name: "FIXED_VALUE",
            source: "value",
            value,
            secret: false,
            applies: "agent",
          },
          {
            name: "INHERITED_VALUE",
            source: "inherit",
            from: "REUSABLE_E2E_WORKER_VALUE",
            secret: true,
            optional: false,
            applies: "agent",
          },
        ],
      },
    };
  }

  async function run(
    environment?: Parameters<typeof buildSingleStepScenario>[0]["environment"],
  ) {
    const scenario = buildSingleStepScenario({
      projectId: createUuidV7(),
      taskRunId: createUuidV7(),
      findings: {},
      environment,
      codeEntrypoint: { sourceFile: probePath },
      repo: { mode: "readOnly" },
    });
    const workerClient = new FakeTaskRunWorkerClient(scenario);
    const checkedOut: string[] = [];
    const built = buildIntegrationDeps({
      workerClient,
      sourceRepoDir: source,
      afterClone: async (workspace) => {
        checkedOut.push(
          (
            await runGit(["-C", workspace, "rev-parse", "origin/main"], {
              label: "fresh default branch",
              timeoutMs: 10_000,
            })
          ).trim(),
        );
      },
    });
    integrations.push(built);
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
        preserveRuntimeOnComplete: keep,
        readLocalEnv: () => readLocalEnvVars(workerProject),
      },
      built.deps,
    );
    expect(result.claimedCount).toBe(1);
    return { scenario, workerClient, built, checkedOut, result };
  }

  function expectBunRun(outcome: Awaited<ReturnType<typeof run>>) {
    expect(outcome.result.processedCount).toBe(1);
    expect(outcome.workerClient.failCalls).toEqual([]);
    expect(outcome.workerClient.completeCalls).toHaveLength(1);
    expect(outcome.workerClient.completeCalls[0]?.errorJson).toBeNull();
    expect(outcome.built.devcontainerLauncher.launchedConfigPaths).toEqual([
      ".scarn/managed-devcontainers/bun1/devcontainer.json",
    ]);
    const result = outcome.workerClient.completeCalls[0]?.resultJson as {
      bunVersion: string;
      cwd: string;
      fixedValue?: string;
      inheritedDigest?: string;
    };
    expect(result.bunVersion).toMatch(/^1\./);
    expect(result.cwd).toStartWith("/workspaces/");
    return result;
  }

  test(
    "one compiled named SDK step runs each version the run context carries, with the inherited worker dotenv value, ignoring a committed environment file",
    async () => {
      const secret = crypto.randomUUID();
      await writeFile(
        path.join(workerProject, ".scarn/.env"),
        `REUSABLE_E2E_WORKER_VALUE=${secret}\n`,
      );
      const compiled = codeStep({
        key: "integration-step",
        name: "Integration Step",
        environment: "e2e",
        repo: Repo.readOnly(),
        fn: () => ({
          bunVersion: process.versions.bun,
          cwd: process.cwd(),
          fixedValue: process.env["FIXED_VALUE"],
          inheritedDigest: new Bun.CryptoHasher("sha256")
            .update(process.env["INHERITED_VALUE"] ?? "")
            .digest("hex"),
        }),
      });
      const probeFunction = compiled.entrypoint?.fn;
      if (!probeFunction)
        throw new Error("SDK code step must carry its function");
      await writeFile(
        path.join(source, probePath),
        `export const runtimeProbeStep = {
  key: ${JSON.stringify(compiled.key)},
  name: ${JSON.stringify(compiled.name)},
  version: ${String(compiled.version)},
  kind: "code",
  entrypoint: { fn: ${probeFunction.toString()} },
};\n`,
      );
      const compiledSnapshot = JSON.stringify(compiled);
      expect(compiled.environment).toEqual({ kind: "named", name: "e2e" });
      const firstSha = await commit("Repository for a named environment");
      expect((await git("ls-files", ".scarn/.env")).trim()).toBe("");
      const first = await run(e2eVersion(1, "first"));
      const expectedDigest = new Bun.CryptoHasher("sha256")
        .update(secret)
        .digest("hex");
      expect(expectBunRun(first)).toMatchObject({
        fixedValue: "first",
        inheritedDigest: expectedDigest,
      });
      expect(first.checkedOut).toEqual([firstSha]);

      await mkdir(path.join(source, ".scarn/environments"), {
        recursive: true,
      });
      await writeFile(
        path.join(source, staleDefinitionPath),
        `{ "runtime": { "managed": "node24" }, "vars": { "FIXED_VALUE": "stale" } }`,
      );
      const secondSha = await commit("Stale pre-server environment file");
      expect(secondSha).not.toBe(firstSha);
      expect(JSON.stringify(compiled)).toBe(compiledSnapshot);
      expect(compiled.entrypoint?.fn).toBe(probeFunction);
      const second = await run(e2eVersion(2, "second"));
      expect(expectBunRun(second)).toMatchObject({
        fixedValue: "second",
        inheritedDigest: expectedDigest,
      });
      expect(second.checkedOut).toEqual([secondSha]);
      expect(JSON.stringify(compiled)).toBe(compiledSnapshot);
      expect(compiled.entrypoint?.fn).toBe(probeFunction);
    },
    3 * 60 * 1000,
  );

  test(
    "genuine RepoDefault with no environment files or devcontainer executes on bun1, but a not-found named environment fails instead of falling back",
    async () => {
      const sha = await commit("Repository without environment definitions");
      const tracked = (await git("ls-files")).split("\n");
      expect(
        tracked.filter(
          (file) =>
            file.startsWith(".scarn/environments/") ||
            file.includes("devcontainer"),
        ),
      ).toEqual([]);
      const fallback = await run();
      expect(
        fallback.scenario.steps[0]?.workerContext.runtime.environment,
      ).toBeNull();
      expect(fallback.checkedOut).toEqual([sha]);
      expectBunRun(fallback);
      const missing = await run({ kind: "named", name: "e2e", notFound: true });
      expect(missing.result.processedCount).toBe(0);
      expect(missing.result.skippedCount).toBe(1);
      expect(missing.workerClient.completeCalls).toEqual([]);
      expect(missing.workerClient.failCalls).toHaveLength(1);
      expect(missing.workerClient.failCalls[0]?.errorJson).toMatchObject({
        message: "Environment not found: e2e",
      });
      expect(missing.built.devcontainerLauncher.launchedConfigPaths).toEqual(
        [],
      );
    },
    3 * 60 * 1000,
  );
});

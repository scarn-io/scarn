import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { runProjectWork } from "../../../../src/work/task-run/application/run-project-work";
import {
  buildIntegrationDeps,
  type IntegrationDeps,
} from "./helpers/build-integration-deps";
import { FakeTaskRunWorkerClient } from "./helpers/fake-worker-client";
import { buildSingleStepScenario } from "./helpers/scenario";

const enabled = process.env["SCARN_INTEGRATION"] === "true";
const keep = process.env["SCARN_INTEGRATION_KEEP_CONTAINERS"] === "true";
const staleDefinitionPath = ".scarn/environments/ci.jsonc";
const probePath =
  ".scarn/pipeline-builder/integration-runtime-probe-code-step.mjs";

describe.skipIf(!enabled)("named managed runtime (integration)", () => {
  let directory: string;
  let originalHome: string | undefined;
  let built: IntegrationDeps | undefined;

  beforeEach(async () => {
    process.env["TESTCONTAINERS_RYUK_DISABLED"] ??= "true";
    directory = await mkdtemp(
      path.join(os.tmpdir(), "scarn-named-managed-it-"),
    );
    originalHome = process.env["HOME"];
    process.env["HOME"] = path.join(directory, "home");
    await mkdir(process.env["HOME"], { recursive: true });
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    if (!keep) {
      await built?.containerRegistry.stopAll();
      await rm(directory, { recursive: true, force: true });
    }
    built = undefined;
  });

  test(
    "a named managed code step takes its environment from the run's context, ignores a committed environment file, probes node24, and commits only its output without OpenCode",
    async () => {
      const fixture = path.join(directory, "fixture");
      await cp(new URL("./helpers/dummy-repo/", import.meta.url), fixture, {
        recursive: true,
      });
      await mkdir(path.join(fixture, ".scarn/environments"), {
        recursive: true,
      });
      await writeFile(
        path.join(fixture, staleDefinitionPath),
        `{
      // A pre-server environment file; runs must ignore it.
      "runtime": "host",
      "repo": { "branch": "main" }
    }`,
      );
      const probe = await readFile(path.join(fixture, probePath), "utf8");
      await writeFile(
        path.join(fixture, probePath),
        `${probe}
import { writeFileSync } from "node:fs";
import { inspectingStep } from "./integration-inspecting-code-step.mjs";
const originalProbe = runtimeProbeStep.entrypoint.fn;
runtimeProbeStep.entrypoint.fn = () => {
  writeFileSync("generated.txt", "named managed output");
  return { ...originalProbe(), ...inspectingStep.entrypoint.fn() };
};
`,
      );
      const scenario = buildSingleStepScenario({
        projectId: createUuidV7(),
        taskRunId: createUuidV7(),
        findings: {},
        environment: {
          kind: "named",
          name: "ci",
          version: 2,
          content: {
            runtime: { kind: "managed", id: "node24" },
          },
        },
        codeEntrypoint: { sourceFile: probePath },
      });
      const workerClient = new FakeTaskRunWorkerClient(scenario);
      built = buildIntegrationDeps({
        workerClient,
        sourceRepoDir: fixture,
        verbose: process.env["SCARN_INTEGRATION_VERBOSE"] === "true",
      });
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
        },
        built.deps,
      );

      expect(result.claimedCount).toBe(1);
      expect(result.processedCount).toBe(1);
      expect(workerClient.failCalls).toEqual([]);
      expect(workerClient.completeCalls).toHaveLength(1);
      expect(workerClient.completeCalls[0]).toMatchObject({
        createdFromBranch: "main",
        errorJson: null,
        resultJson: {
          bunVersion: null,
          opencodeProcesses: [],
          opencodePluginPresent: false,
          opencodeDirectoryPresent: false,
        },
      });
      const runtimeProbe = workerClient.completeCalls[0]?.resultJson as {
        nodeVersion: string;
        cwd: string;
        processCount: number;
      };
      expect(runtimeProbe.nodeVersion).toStartWith("24.");
      expect(runtimeProbe.cwd).toStartWith("/workspaces/");
      expect(runtimeProbe.processCount).toBeGreaterThan(0);
      expect(built.devcontainerLauncher.launchedConfigPaths).toEqual([
        ".scarn/managed-devcontainers/node24/devcontainer.json",
      ]);
      expect(built.devcontainerLauncher.launches).toMatchObject([
        { mounts: [], publishedPort: null },
      ]);
      const committed = built.gitCommitPushService.committedFiles.flat();
      expect(committed).toContain("generated.txt");
      expect(
        committed.filter(
          (file) =>
            file.startsWith(".scarn/managed-devcontainers") ||
            file.startsWith(".scarn/pipeline-builder/node_modules"),
        ),
      ).toEqual([]);
    },
    3 * 60 * 1000,
  );
});

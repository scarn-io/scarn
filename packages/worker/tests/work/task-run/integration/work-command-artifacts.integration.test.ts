/**
 * Integration test for artifact persistence in the `work` command
 * (SINGLE-CONTAINER model).
 *
 * Verifies that after the in-container OpenCode agent session stops, the worker
 * collects files from <workspace>/.scarn/step-artifacts/ and persists them
 * through the ArtifactStore (LocalArtifactStore pointed at a temp dir for this
 * test). In the single-container model the workspace is one bind mount shared
 * by the in-container agent and the host worker, so artifact writes are visible
 * immediately — there is no second container and no bind-mount propagation
 * retry across containers.
 *
 * Artifact files are pre-seeded into the workspace bind-mount by the
 * SeedingGitCloneService (a wrapper around FakeGitCloneService that writes
 * configured files into step-artifacts/ after the dummy repo is copied). This
 * guarantees the files exist on the host before collectStepArtifacts runs,
 * without requiring the fake AI to execute arbitrary commands.
 *
 * What is faked (same as the agent-step test in
 * `work-command-runtime.integration.test.ts`):
 *   - Platform server: FakeTaskRunWorkerClient
 *   - AI provider: FakeAiServer
 *   - git clone: SeedingGitCloneService (FakeGitCloneService + artifact seeds)
 *
 * What this test adds over that agent-step test:
 *   - Injects a LocalArtifactStore pointed at a dedicated temp dir.
 *   - Seeds two artifact files (a flat file and a nested file) into the
 *     workspace step-artifacts dir before the agent starts.
 *   - After runProjectWork completes, asserts both files have been copied into
 *     the artifact store at the expected paths with the expected content.
 *
 * Gated behind SCARN_INTEGRATION=true.
 *
 * Run with:
 *   SCARN_INTEGRATION=true bun test tests/work/task-run/integration
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeStepArtifactSubmissions } from "@scarn/sdk/contracts/step-artifact-submissions";
import { createUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import type { SaveArtifactBundleInput } from "../../../../src/artifacts/artifact-store/domain/artifact-store";
import { CompositeArtifactStore } from "../../../../src/artifacts/artifact-store/infra/composite-artifact-store";
import { LocalArtifactStore } from "../../../../src/artifacts/artifact-store/infra/local-artifact-store";
import { runProjectWork } from "../../../../src/work/task-run/application/run-project-work";
import {
  FakeAiServer,
  seedOpencodeConfig,
} from "../../../../src/work/task-run/infra/fake-ai";
import { FakeTaskRunWorkerClient } from "./helpers/fake-worker-client";
import { buildIntegrationDeps } from "./helpers/build-integration-deps";
import { buildSingleStepScenario } from "./helpers/scenario";
import type { ContainerRegistry } from "./helpers/containers/container-registry";

const integrationEnabled = process.env["SCARN_INTEGRATION"] === "true";
const keepContainers =
  process.env["SCARN_INTEGRATION_KEEP_CONTAINERS"] === "true";
const TEST_TIMEOUT_MS = 5 * 60 * 1000;

describe.skipIf(!integrationEnabled)(
  "work command artifact persistence (integration)",
  () => {
    let fakeAi: FakeAiServer;
    let homeDir: string;
    let artifactsBaseDir: string;
    let originalHome: string | undefined;
    let containerRegistry: ContainerRegistry | undefined;

    beforeEach(async () => {
      if (process.env["TESTCONTAINERS_RYUK_DISABLED"] === undefined) {
        process.env["TESTCONTAINERS_RYUK_DISABLED"] = "true";
      }

      fakeAi = new FakeAiServer();
      homeDir = await mkdtemp(
        path.join(os.tmpdir(), "scarn-work-artifacts-it-home-"),
      );
      artifactsBaseDir = await mkdtemp(
        path.join(os.tmpdir(), "scarn-work-artifacts-it-store-"),
      );
      originalHome = process.env["HOME"];
      process.env["HOME"] = homeDir;
    });

    afterEach(async () => {
      if (keepContainers) {
        containerRegistry = undefined;
        await fakeAi.stop().catch(() => undefined);
        if (originalHome === undefined) {
          delete process.env["HOME"];
        } else {
          process.env["HOME"] = originalHome;
        }
        return;
      }

      await containerRegistry?.stopAll();
      containerRegistry = undefined;
      await fakeAi.stop().catch(() => undefined);
      if (originalHome === undefined) {
        delete process.env["HOME"];
      } else {
        process.env["HOME"] = originalHome;
      }
      await rm(homeDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
      await rm(artifactsBaseDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
    });

    test(
      "collects seeded step-artifacts and persists them to the artifact store",
      async () => {
        const projectId = createUuidV7();
        const taskRunId = createUuidV7();
        const findings = { confidence: 1, summary: "artifact persistence ok" };

        const scenario = buildSingleStepScenario({
          projectId,
          taskRunId,
          prompt: "Submit the integration findings.",
          findings,
        });

        // Two artifacts: a flat file and a nested file, to verify that the
        // recursive readdir walk in collectStepArtifacts preserves the relative
        // directory structure (relativeStorePath) when copying into the store.
        const seedArtifacts = [
          {
            relativePath: "report.txt",
            content: "artifact-report-contents",
          },
          {
            relativePath: path.join("logs", "run.log"),
            content: "artifact-run-log-contents",
          },
        ];

        const artifactStore = new LocalArtifactStore(artifactsBaseDir);

        const fakeAiPort = await fakeAi.start();
        fakeAi.configure("scarn-submit-step-findings", {
          findingsJson: findings,
        });
        await seedOpencodeConfig(homeDir, fakeAiPort);

        const workerClient = new FakeTaskRunWorkerClient(scenario);
        const built = buildIntegrationDeps({
          workerClient,
          verbose: process.env["SCARN_INTEGRATION_VERBOSE"] === "true",
          seedArtifacts,
          artifactStore,
        });
        containerRegistry = built.containerRegistry;

        const result = await runProjectWork(
          {
            projectId,
            baseUrl: "http://127.0.0.1:1",
            concurrency: 1,
            batchSize: 1,
            pollIntervalMs: 250,
            missingFindingsGraceMs: 5_000,
            leaseDurationSeconds: 60,
            once: true,
            preserveRuntimeOnComplete: keepContainers,
          },
          built.deps,
        );

        // Step still completes successfully despite the artifact collection.
        expect(result.claimedCount).toBe(1);
        expect(result.processedCount).toBe(1);
        expect(result.skippedCount).toBe(0);
        expect(workerClient.completeCalls).toHaveLength(1);
        expect(workerClient.failCalls).toHaveLength(0);
        expect(workerClient.completeCalls[0]?.resultJson).toEqual(findings);

        // Both artifact files were copied into the artifact store under the
        // correct taskRunId prefix with their relative paths intact.
        for (const seed of seedArtifacts) {
          const storedPath = path.join(
            artifactsBaseDir,
            taskRunId,
            seed.relativePath,
          );
          const storedContent = await readFile(storedPath, "utf8");
          expect(storedContent).toBe(seed.content);
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "saves a submitted bundle as one bundle and keeps its tree in the local store",
      async () => {
        const projectId = createUuidV7();
        const taskRunId = createUuidV7();
        const findings = { confidence: 1, summary: "bundle persistence ok" };
        const scenario = buildSingleStepScenario({
          projectId,
          taskRunId,
          prompt: "Submit the integration findings.",
          findings,
        });
        const seedArtifacts = [
          { relativePath: "report/index.html", content: "<h1>report</h1>" },
          { relativePath: "report/img/shot.png", content: "png-bytes" },
          { relativePath: "notes.txt", content: "loose-file" },
        ];

        const savedBundles: SaveArtifactBundleInput[] = [];
        const artifactStore = new CompositeArtifactStore([
          new LocalArtifactStore(artifactsBaseDir),
          {
            saveArtifact: () =>
              Promise.resolve({ storeRef: "recorded", sizeBytes: 0 }),
            saveBundle: (input) => {
              savedBundles.push(input);
              return Promise.resolve({
                storeRef: "bundle-1",
                sizeBytes: 0,
                fileCount: input.members.length,
              });
            },
          },
        ]);

        const fakeAiPort = await fakeAi.start();
        fakeAi.configure("scarn-submit-step-findings", {
          findingsJson: findings,
        });
        await seedOpencodeConfig(homeDir, fakeAiPort);

        const workerClient = new FakeTaskRunWorkerClient(scenario);
        const built = buildIntegrationDeps({
          workerClient,
          verbose: process.env["SCARN_INTEGRATION_VERBOSE"] === "true",
          seedArtifacts,
          artifactStore,
          afterClone: (workspacePath) =>
            writeStepArtifactSubmissions(workspacePath, {
              fields: {},
              extra: [
                {
                  kind: "bundle",
                  stored: "report",
                  sourcePath: "out/report",
                  sizeBytes: 24,
                  entry: "index.html",
                  fileCount: 2,
                },
              ],
            }),
        });
        containerRegistry = built.containerRegistry;

        await runProjectWork(
          {
            projectId,
            baseUrl: "http://127.0.0.1:1",
            concurrency: 1,
            batchSize: 1,
            pollIntervalMs: 250,
            missingFindingsGraceMs: 5_000,
            leaseDurationSeconds: 60,
            once: true,
            preserveRuntimeOnComplete: keepContainers,
          },
          built.deps,
        );

        expect(workerClient.completeCalls).toHaveLength(1);
        expect(savedBundles).toHaveLength(1);
        expect(savedBundles[0]).toMatchObject({
          name: "report",
          rootPath: "report",
          entryPath: "index.html",
        });
        expect(
          savedBundles[0]?.members.map((member) => member.path).sort(),
        ).toEqual(["img/shot.png", "index.html"]);
        for (const seed of seedArtifacts) {
          const storedContent = await readFile(
            path.join(artifactsBaseDir, taskRunId, seed.relativePath),
            "utf8",
          );
          expect(storedContent).toBe(seed.content);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

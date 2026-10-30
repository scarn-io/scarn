/**
 * Integration tests for a steered rerun (`workerContext.previousRun`), through
 * the real `work` loop and a real Docker devcontainer (see
 * `work-command-runtime.integration.test.ts` for the setup and the env flags).
 *
 *   - A code step sees `.scarn/previous-run/findings.json` and
 *     `transcript.txt` inside its container, and neither reaches the pushed
 *     work-branch commit.
 *   - A fake-AI agent step whose previous run's logs cannot be read still
 *     completes, with findings but no transcript.
 *
 * The fake AI only forces the findings tool call, so it cannot show an agent
 * reading the files; the code step is what proves they are in the runtime.
 *
 *   SCARN_INTEGRATION=true bun test tests/work/task-run/integration/work-command-steered-rerun
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TaskLogLinesResult } from "@scarn/shared-core";
import { createUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { runProjectWork } from "../../../../src/work/task-run/application/run-project-work";
import {
  FakeAiServer,
  seedOpencodeConfig,
} from "../../../../src/work/task-run/infra/fake-ai";
import { FakeTaskRunWorkerClient } from "./helpers/fake-worker-client";
import {
  buildIntegrationDeps,
  type IntegrationDeps,
} from "./helpers/build-integration-deps";
import { buildSingleStepScenario, type WorkScenario } from "./helpers/scenario";

const integrationEnabled = process.env["SCARN_INTEGRATION"] === "true";
const TEST_TIMEOUT_MS = 3 * 60 * 1000;
const PREVIOUS_RUN_CODE_STEP_ENTRYPOINT = {
  sourceFile: ".scarn/pipeline-builder/integration-previous-run-code-step.mjs",
};
const PREVIOUS_FINDINGS = { summary: "first attempt", confidence: 0.4 };

function previousRun(taskRunId: string) {
  return {
    taskRunId,
    status: "succeeded" as const,
    transcriptRelativePath: ".scarn/previous-run/transcript.txt",
    findingsRelativePath: ".scarn/previous-run/findings.json",
    findingsJson: PREVIOUS_FINDINGS,
  };
}

const PREVIOUS_LOGS: TaskLogLinesResult = {
  source: "archive",
  lines: [
    {
      seq: 1,
      stream: "conversation",
      ts: "2026-10-16T10:00:00.000Z",
      content: JSON.stringify({
        kind: "text",
        messageId: "m1",
        partId: "p1",
        role: "assistant",
        text: "I only fixed half of it.",
      }),
      level: "info",
    },
  ],
};

describe.skipIf(!integrationEnabled)("steered rerun (integration)", () => {
  let fakeAi: FakeAiServer;
  let homeDir: string;
  let originalHome: string | undefined;
  let built: IntegrationDeps | undefined;

  beforeEach(async () => {
    if (process.env["TESTCONTAINERS_RYUK_DISABLED"] === undefined) {
      process.env["TESTCONTAINERS_RYUK_DISABLED"] = "true";
    }
    fakeAi = new FakeAiServer();
    homeDir = await mkdtemp(path.join(os.tmpdir(), "scarn-steer-it-home-"));
    originalHome = process.env["HOME"];
    process.env["HOME"] = homeDir;
  });

  afterEach(async () => {
    await built?.containerRegistry.stopAll();
    built = undefined;
    await fakeAi.stop().catch(() => undefined);
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
    await rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
  });

  async function runScenario(
    scenario: WorkScenario,
    findings: Record<string, unknown>,
    taskLogLines: (taskRunId: string) => TaskLogLinesResult,
  ) {
    const fakeAiPort = await fakeAi.start();
    fakeAi.configure("scarn-submit-step-findings", {
      findingsJson: findings,
    });
    await seedOpencodeConfig(homeDir, fakeAiPort);

    const workerClient = new FakeTaskRunWorkerClient(scenario, taskLogLines);
    const integration = buildIntegrationDeps({
      workerClient,
      verbose: process.env["SCARN_INTEGRATION_VERBOSE"] === "true",
    });
    built = integration;

    await runProjectWork(
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
        preserveRuntimeOnComplete: false,
      },
      integration.deps,
    );
    return { workerClient, integration };
  }

  test(
    "a steered code step reads the previous run's files in its container and never commits them",
    async () => {
      const previousTaskRunId = createUuidV7();
      const { workerClient, integration } = await runScenario(
        buildSingleStepScenario({
          projectId: createUuidV7(),
          taskRunId: createUuidV7(),
          findings: {},
          codeEntrypoint: PREVIOUS_RUN_CODE_STEP_ENTRYPOINT,
          previousRun: previousRun(previousTaskRunId),
        }),
        {},
        () => PREVIOUS_LOGS,
      );

      expect(workerClient.failCalls).toHaveLength(0);
      expect(workerClient.completeCalls).toHaveLength(1);
      expect(workerClient.loadTaskLogLinesCalls).toEqual([previousTaskRunId]);
      const result = workerClient.completeCalls[0]?.resultJson as {
        findings: string | null;
        transcript: string | null;
      };
      expect(JSON.parse(result.findings ?? "")).toEqual(PREVIOUS_FINDINGS);
      expect(result.transcript).toContain(
        "[assistant] I only fixed half of it.",
      );

      const committed = integration.gitCommitPushService.committedFiles.flat();
      expect(committed).toContain("generated.txt");
      expect(
        committed.filter((file) => file.startsWith(".scarn/previous-run")),
      ).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a steered agent step completes when the previous run's logs cannot be read",
    async () => {
      const findings = { confidence: 1, summary: "steered ok" };
      const previousTaskRunId = createUuidV7();
      const { workerClient, integration } = await runScenario(
        buildSingleStepScenario({
          projectId: createUuidV7(),
          taskRunId: createUuidV7(),
          findings,
          previousRun: previousRun(previousTaskRunId),
        }),
        findings,
        () => ({ unavailable: "log archive read quota exceeded (402)" }),
      );

      expect(workerClient.failCalls).toHaveLength(0);
      expect(workerClient.completeCalls).toHaveLength(1);
      expect(workerClient.completeCalls[0]?.resultJson).toEqual(findings);
      expect(workerClient.loadTaskLogLinesCalls).toEqual([previousTaskRunId]);
      expect(
        integration.gitCommitPushService.committedFiles
          .flat()
          .filter((file) => file.startsWith(".scarn/previous-run")),
      ).toEqual([]);
      expect(fakeAi.requestCount).toBeGreaterThanOrEqual(2);
    },
    TEST_TIMEOUT_MS,
  );
});

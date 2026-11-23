/**
 * A code step with `mcps` end to end in the managed `bun1` container: the
 * launch resolves its server and patches the host-gateway run args, the
 * claimed-run branch opens the MCP bridge and hands its URL and token to the
 * runner, and the step's `context.mcp` calls the dependency-free fixture
 * server (`e2e-tool-mcp.mjs`, started by the bridge with `docker exec -i` in
 * the same container) three times. Platform responses are fake; the bridge,
 * container and code execution are real.
 */
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { createUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { runProjectWork } from "../../../../src/work/task-run/application/run-project-work";
import {
  buildIntegrationDeps,
  type IntegrationDeps,
} from "./helpers/build-integration-deps";
import { FakeTaskRunWorkerClient } from "./helpers/fake-worker-client";
import {
  bridgeStep,
  TOOL_SERVER_PATH,
} from "./helpers/mcp/code-step-mcp-bridge-step";
import { buildSingleStepScenario } from "./helpers/scenario";

const enabled = process.env["SCARN_INTEGRATION"] === "true";
const keep = process.env["SCARN_INTEGRATION_KEEP_CONTAINERS"] === "true";
const STEP_PATH = ".scarn/pipeline-builder/integration-mcp-bridge-step.mjs";
const FIXTURE_SERVER = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "e2e-tests",
  "tests",
  "fixtures",
  "e2e-tool-mcp.mjs",
);

const execFileAsync = promisify(execFile);

describe.skipIf(!enabled)(
  "code step MCP calls through the bridge in the managed bun container (integration)",
  () => {
    let scratch: string;
    let bundle: string;
    const integrations: IntegrationDeps[] = [];

    beforeAll(async () => {
      process.env["TESTCONTAINERS_RYUK_DISABLED"] ??= "true";
      scratch = await mkdtemp(path.join(os.tmpdir(), "scarn-code-mcp-it-"));
      bundle = path.join(scratch, "step.mjs");
      await execFileAsync(process.execPath, [
        "build",
        path.join(
          import.meta.dirname,
          "helpers",
          "mcp",
          "code-step-mcp-bridge-step.ts",
        ),
        "--target=bun",
        "--format=esm",
        `--outfile=${bundle}`,
      ]);
    }, 120_000);

    afterEach(async () => {
      if (!keep) {
        for (const built of integrations) {
          await built.containerRegistry.stopAll();
        }
      }
      integrations.length = 0;
    });

    afterAll(async () => {
      await rm(scratch, { recursive: true, force: true });
    });

    test(
      "the step calls its server three times and returns the results",
      async () => {
        const scenario = buildSingleStepScenario({
          projectId: createUuidV7(),
          taskRunId: createUuidV7(),
          findings: {},
          managedRuntime: "bun1",
          codeEntrypoint: { sourceFile: STEP_PATH },
          repo: { mode: "readOnly" },
        });
        const step = scenario.steps[0];
        if (!step) throw new Error("scenario must have a step");
        step.workerContext.runtime.opencodeMcpJson = bridgeStep.opencodeMcpJson;
        const workerClient = new FakeTaskRunWorkerClient(scenario);
        const built = buildIntegrationDeps({
          workerClient,
          afterClone: async (workspace) => {
            await mkdir(path.join(workspace, path.dirname(STEP_PATH)), {
              recursive: true,
            });
            await copyFile(bundle, path.join(workspace, STEP_PATH));
            await copyFile(
              FIXTURE_SERVER,
              path.join(workspace, TOOL_SERVER_PATH),
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
          },
          built.deps,
        );

        expect(workerClient.failCalls).toEqual([]);
        expect(result.processedCount).toBe(1);
        expect(built.devcontainerLauncher.launchedConfigPaths).toEqual([
          ".scarn/managed-devcontainers/bun1/devcontainer.json",
        ]);
        expect(workerClient.completeCalls).toHaveLength(1);
        expect(workerClient.completeCalls[0]?.resultJson).toEqual({
          results: [
            {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ found: true, title: "Found alpha" }),
                },
              ],
              structuredContent: { found: true, title: "Found alpha" },
            },
            {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    found: false,
                    title: "Found missing",
                  }),
                },
              ],
              structuredContent: { found: false, title: "Found missing" },
            },
            {
              content: [{ type: "text", text: 'filed "Weekly"' }],
              structuredContent: null,
            },
          ],
        });
      },
      3 * 60 * 1000,
    );
  },
);

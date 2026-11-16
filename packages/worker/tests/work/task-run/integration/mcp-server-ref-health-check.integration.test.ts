/**
 * Integration test for MCP server refs, end to end: a step declares
 * `{ type: "ref" }` and the server is defined only in the project's
 * `.opencode/opencode.json` (v1 shape, as real user configs still are). The
 * worker resolves the ref, OpenCode starts the real fixture MCP server, and a
 * forced health check call through the ref'd key passes.
 *
 * Uses the shared checkout orchestrator (a real host `opencode serve`, no
 * Docker). The test commits the project config to a local repository before
 * launch clones it. OpenCode also loads that same
 * project config natively, so this covers the overlay and the user config
 * both defining the server.
 *
 * Gated behind SCARN_INTEGRATION=true, like
 * `force-and-verify-mcp-health-check.integration.test.ts`.
 *
 * Run with:
 *   SCARN_INTEGRATION=true bun test tests/work/task-run/integration/mcp-server-ref-health-check.integration.test.ts
 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { forceAndVerifyMcpHealthCheck } from "../../../../src/work/task-run/application/force-and-verify-mcp-health-check";
import { checkMcpStartupGate } from "../../../../src/work/task-run/application/mcp-startup-gate";
import { planStepEnv } from "../../../../src/work/task-run/application/resolve-step-env";
import type { OpenCodeMcpServers } from "../../../../src/common/contracts/opencode-mcp";
import {
  createUuidV7,
  type UuidV7,
} from "../../../../src/common/contracts/uuid-v7";
import { FakeAiServer } from "../../../../src/work/task-run/infra/fake-ai/fake-ai-server";
import { buildHostCheckout } from "./helpers/build-host-checkout";
import type { LaunchedRuntime } from "../../../../src/work/task-run/contracts/process-project-work-types";

const integrationEnabled = process.env["SCARN_INTEGRATION"] === "true";
const TEST_TIMEOUT_MS = 3 * 60 * 1000;

const FIXTURE_SERVER_PATH = path.join(
  import.meta.dirname,
  "helpers",
  "mcp",
  "fixture-mcp-server.ts",
);

describe.skipIf(!integrationEnabled)(
  "MCP server ref health check (integration)",
  () => {
    let fakeAiServer: FakeAiServer;
    let environment: LaunchedRuntime | undefined;
    let checkout: Awaited<ReturnType<typeof buildHostCheckout>>;

    beforeEach(async () => {
      fakeAiServer = new FakeAiServer({
        verbose: process.env["SCARN_INTEGRATION_VERBOSE"] === "true",
      });
      checkout = await buildHostCheckout();
    });

    afterEach(async () => {
      await environment?.cleanup().catch(() => undefined);
      environment = undefined;
      await fakeAiServer.stop().catch(() => undefined);
      await checkout.dispose();
    });

    async function launch(
      sessionId: UuidV7,
      opencodeMcpJson: OpenCodeMcpServers,
    ) {
      await fakeAiServer.start();
      const { resolved, resolveMcpEnv } = planStepEnv({
        envVars: [],
        inputJson: {},
        workerEnv: process.env,
        opencodeMcpJson,
      });
      environment = await checkout.orchestrator.launch({
        environment: { kind: "inline", runtime: { kind: "host" } },
        claimToken: "integration-claim-token",
        startAgent: true,
        sessionId,
        projectId: createUuidV7(),
        requestedByUserId: createUuidV7(),
        gitUrl: checkout.gitUrl,
        repo: {
          mode: "readOnly",
          gitCredentials: "none",
          baseBranch: null,
        },
        opencodeMcpJson,
        stepEnv: resolved.stepEnv,
        resolveMcpEnv,
        currentExecutionInfo: {
          taskRunId: sessionId,
          resultSchemaJson: null,
          turnsRemaining: null,
        },
        fakeAiProviderOverride: {
          baseUrl: `http://127.0.0.1:${String(fakeAiServer.port)}`,
        },
      });
      const { agent } = environment;
      if (!agent) {
        throw new Error("Expected the launch to start an agent");
      }
      return {
        environment,
        server: {
          baseUrl: agent.baseUrl,
          password: agent.password,
          workspaceFolder: environment.workspaceFolder,
        },
      };
    }

    test(
      "a ref resolved from the project config starts and answers a forced tool call",
      async () => {
        const sessionId = createUuidV7();
        await checkout.seedMcpConfig({
          "fixture-source": {
            type: "local",
            command: ["bun", "run", FIXTURE_SERVER_PATH],
            enabled: true,
          },
        });

        const { server } = await launch(sessionId, {
          fixture: { type: "ref", name: "fixture-source" },
        });

        const statuses = await checkMcpStartupGate(server, ["fixture"]);
        expect(
          statuses.find((status) => status.name === "fixture")?.healthy,
        ).toBe(true);

        const result = await forceAndVerifyMcpHealthCheck({
          server,
          healthCheck: { tool: "fixture_echo", args: { text: "ping" } },
          fakeAiServer,
          timeoutMs: 30_000,
        });
        expect(result).toEqual({ passed: true });
      },
      TEST_TIMEOUT_MS,
    );
  },
);

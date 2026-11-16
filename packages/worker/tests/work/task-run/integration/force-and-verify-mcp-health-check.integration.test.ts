/**
 * Integration test for `forceAndVerifyMcpHealthCheck`.
 *
 * Exercises the real thing end to end: a real OpenCode `opencode serve`
 * process spawned directly on the host (via the shared checkout
 * orchestrator the dry-run feature uses — no Docker needed for this path), a
 * real fake-LLM server (`FakeAiServer`, real HTTP, real Anthropic wire
 * format), and a REAL (not mocked) stdio MCP server
 * (`helpers/mcp/fixture-mcp-server.ts`, speaking the actual MCP protocol via
 * the official SDK). Only the AI provider is faked — the MCP server and the
 * OpenCode process are both real.
 *
 * Proves the working-vs-broken distinction the ticket's acceptance criteria
 * calls for:
 *   - `fixture_echo`  — a working tool call → `{ passed: true }`.
 *   - `fixture_boom`  — a genuinely broken tool call (throws) → `{ passed:
 *     false, reason: "tool-error", detail: <the real MCP error message> }`.
 *
 * Gated behind SCARN_INTEGRATION=true because it provisions the real
 * OpenCode runtime payload (downloaded from the npm registry) and spawns a
 * real host process, matching the convention used by
 * `work-command-runtime.integration.test.ts`.
 *
 * Run with:
 *   SCARN_INTEGRATION=true bun test tests/work/task-run/integration/force-and-verify-mcp-health-check.integration.test.ts
 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { forceAndVerifyMcpHealthCheck } from "../../../../src/work/task-run/application/force-and-verify-mcp-health-check";
import { checkMcpStartupGate } from "../../../../src/work/task-run/application/mcp-startup-gate";
import { createUuidV7 } from "../../../../src/common/contracts/uuid-v7";
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
  "forceAndVerifyMcpHealthCheck (integration)",
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

    test(
      "distinguishes a working MCP tool call from a genuinely broken one",
      async () => {
        // The agent runs directly on the host, alongside the fake-LLM server —
        // no docker.internal indirection needed. Start the fake-LLM server
        // first so its URL can be baked into the agent's launch-time config.
        await fakeAiServer.start();

        const sessionId = createUuidV7();
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
          opencodeMcpJson: {
            fixture: {
              type: "local",
              command: ["bun", "run", FIXTURE_SERVER_PATH],
            },
          },
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

        // What the MCP startup gate does: OpenCode 2.x connects MCP
        // servers after readiness, so a call forced immediately can race the
        // catalog. Naming the expected server keeps an empty just-booted list
        // from counting as settled.
        const mcpReport = await checkMcpStartupGate(
          {
            baseUrl: agent.baseUrl,
            password: agent.password,
            workspaceFolder: environment.workspaceFolder,
          },
          ["fixture"],
        );
        expect(mcpReport.find(({ name }) => name === "fixture")?.status).toBe(
          "connected",
        );

        const working = await forceAndVerifyMcpHealthCheck({
          server: {
            baseUrl: agent.baseUrl,
            password: agent.password,
            workspaceFolder: environment.workspaceFolder,
          },
          healthCheck: { tool: "fixture_echo", args: { text: "ping" } },
          fakeAiServer,
          timeoutMs: 30_000,
        });
        expect(working).toEqual({ passed: true });

        const broken = await forceAndVerifyMcpHealthCheck({
          server: {
            baseUrl: agent.baseUrl,
            password: agent.password,
            workspaceFolder: environment.workspaceFolder,
          },
          healthCheck: { tool: "fixture_boom", args: {} },
          fakeAiServer,
          timeoutMs: 30_000,
        });
        expect(broken.passed).toBe(false);
        if (!broken.passed) {
          expect(broken.reason).toBe("tool-error");
          expect(broken.detail).toContain(
            "boom: intentionally broken fixture tool",
          );
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

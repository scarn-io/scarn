/**
 * Integration test for the health check runner (#119).
 *
 * Exercises the same real pieces
 * `force-and-verify-mcp-health-check.integration.test.ts` does — a real
 * `opencode serve` process (via the shared host checkout orchestrator), a real
 * `FakeAiServer`, and the real stdio fixture MCP server
 * (`helpers/mcp/fixture-mcp-server.ts`, exposing a working `echo` tool and a
 * deliberately throwing `boom` tool) — but drives them through
 * `runHealthChecks`, the actual function a step declaring `healthChecks`
 * calls, rather than the single-call invoker underneath it directly.
 *
 * Covers what only a real OpenCode process can prove:
 *   - A working MCP tool call passes; a throwing one fails with the tool's
 *     real error message.
 *   - `required` checks run in declaration order and the first failure
 *     aborts everything after it, including a later `warn` check.
 *   - A tool that was never registered (a real, non-MCP id — MCP tools never
 *     appear in OpenCode's enumeration per the #114 spike) fails fast, before
 *     any session is created, and reports the real available ids.
 *
 * Gated behind SCARN_INTEGRATION=true — see
 * `force-and-verify-mcp-health-check.integration.test.ts` for why.
 *
 * Run with:
 *   SCARN_INTEGRATION=true bun test tests/work/task-run/integration/run-health-checks.integration.test.ts
 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { HealthCheck, ToolHealthCheck } from "@scarn/sdk/health-checks";
import { checkMcpStartupGate } from "../../../../src/work/task-run/application/mcp-startup-gate";
import { runHealthChecks } from "../../../../src/work/task-run/application/run-health-checks";
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

function buildCheck(
  overrides: Partial<ToolHealthCheck> & { tool: string },
): HealthCheck {
  return {
    kind: "tool",
    mcp: undefined,
    name: undefined,
    args: {},
    severity: "required",
    timeoutSeconds: 30,
    ...overrides,
  };
}

function echoCheck(overrides: Partial<ToolHealthCheck> = {}): HealthCheck {
  return buildCheck({
    mcp: "fixture",
    tool: "echo",
    args: { text: "ping" },
    ...overrides,
  });
}

function boomCheck(overrides: Partial<ToolHealthCheck> = {}): HealthCheck {
  return buildCheck({ mcp: "fixture", tool: "boom", ...overrides });
}

describe.skipIf(!integrationEnabled)("runHealthChecks (integration)", () => {
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
    "runs declared checks against a real OpenCode process and a real MCP server",
    async () => {
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

      const server = {
        baseUrl: agent.baseUrl,
        password: agent.password,
        workspaceFolder: environment.workspaceFolder,
      };
      // The real sequence: the MCP startup gate runs before declared checks,
      // so the fixture server is connected when the first check fires.
      const gate = await checkMcpStartupGate(server, ["fixture"]);
      expect(gate.map(({ name, status }) => [name, status])).toEqual([
        ["fixture", "connected"],
      ]);

      // A single working MCP check passes.
      const working = await runHealthChecks({
        server,
        healthChecks: [echoCheck()],
        fakeAiServer,
      });
      expect(working).toEqual([
        {
          name: "fixture_echo",
          resolvedId: "fixture_echo",
          severity: "required",
          kind: "tool",
          outcome: { kind: "passed" },
        },
      ]);

      // A single throwing MCP check fails with the tool's real error message.
      const broken = await runHealthChecks({
        server: {
          baseUrl: agent.baseUrl,
          password: agent.password,
          workspaceFolder: environment.workspaceFolder,
        },
        healthChecks: [boomCheck()],
        fakeAiServer,
      });
      expect(broken).toHaveLength(1);
      expect(broken[0]?.outcome.kind).toBe("failed");
      if (broken[0]?.outcome.kind === "failed") {
        expect(broken[0].outcome.reason).toBe("tool-error");
        expect(broken[0].outcome.detail).toContain(
          "boom: intentionally broken fixture tool",
        );
      }

      // required checks run in declaration order; the first failure aborts
      // everything after it, including a later `warn` check. `serialGroup`
      // pins "first"/"second"/"third" to one lane — required checks run in
      // PARALLEL lanes by default (see `run-health-checks.ts`), so without a
      // shared group "third" would start concurrently with "second" instead
      // of waiting to observe its failure.
      const orderedWithAbort = await runHealthChecks({
        server: {
          baseUrl: agent.baseUrl,
          password: agent.password,
          workspaceFolder: environment.workspaceFolder,
        },
        healthChecks: [
          echoCheck({ name: "first (passes)", serialGroup: "ordered" }),
          boomCheck({
            name: "second (fails, aborts the rest)",
            serialGroup: "ordered",
          }),
          echoCheck({
            name: "third (required, never reached)",
            serialGroup: "ordered",
          }),
          echoCheck({ name: "fourth (warn, never reached)", severity: "warn" }),
        ],
        fakeAiServer,
      });
      expect(
        orderedWithAbort.map((report) => ({
          name: report.name,
          kind: report.outcome.kind,
        })),
      ).toEqual([
        { name: "first (passes)", kind: "passed" },
        { name: "second (fails, aborts the rest)", kind: "failed" },
        { name: "third (required, never reached)", kind: "skipped" },
        { name: "fourth (warn, never reached)", kind: "skipped" },
      ]);

      // A tool that was never registered fails fast — before any session is
      // created — and reports the real ids OpenCode does know about. MCP
      // tools never appear in that enumeration (#114 spike), so this uses a
      // non-MCP (flat) tool id, matching the runner's degraded-for-MCP design.
      const startedAt = Date.now();
      const neverRegistered = await runHealthChecks({
        server: {
          baseUrl: agent.baseUrl,
          password: agent.password,
          workspaceFolder: environment.workspaceFolder,
        },
        healthChecks: [
          buildCheck({ tool: "totally-fake-tool-that-does-not-exist" }),
        ],
        fakeAiServer,
      });
      const elapsedMs = Date.now() - startedAt;

      expect(neverRegistered).toHaveLength(1);
      expect(neverRegistered[0]?.outcome.kind).toBe("failed");
      if (neverRegistered[0]?.outcome.kind === "failed") {
        expect(neverRegistered[0].outcome.reason).toBe("not-registered");
        expect(neverRegistered[0].outcome.availableIds).toBeDefined();
        expect(neverRegistered[0].outcome.availableIds?.length).toBeGreaterThan(
          0,
        );
      }
      // Real built-in tools (always registered) prove the enumeration was
      // genuinely queried, not stubbed.
      if (neverRegistered[0]?.outcome.kind === "failed") {
        expect(neverRegistered[0].outcome.availableIds).toContain("shell");
      }
      expect(elapsedMs).toBeLessThan(10_000);
    },
    TEST_TIMEOUT_MS,
  );
});

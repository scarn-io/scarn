/**
 * Dry runs of a code step (ADR 0016 decision 8): launched without an agent,
 * as in a real run, with its `defineMcp` checks run directly through a pool
 * over the launch's `mcpCalls`, so the report shows them as it does for an
 * agent step's.
 */
import { describe, expect, test } from "bun:test";
import {
  createLazyFakeAiServer,
  dryRunAgentLaunchFields,
  dryRunStepUsesAgent,
  runCodeStepDryRunChecks,
  runDryRunStepChecks,
} from "../../../../src/work/task-run/application/dry-run-step-checks";
import {
  runInDryRunEnvironment,
  type DryRunLaunchInput,
} from "../../../../src/work/task-run/application/dry-run-environment";
import type { LaunchedRuntime } from "../../../../src/work/task-run/contracts/process-project-work-types";
import type { McpCallLaunch } from "../../../../src/work/task-run/contracts/launched-runtime-handles";
import type { FakeAiServer } from "../../../../src/work/task-run/infra/fake-ai";
import { createFakePool } from "../../../runtime/mcp-bridge/unit/helpers/fake-mcp-connection-pool";
import { cliHealthCheck, healthCheck } from "./helpers/fake-health-check-agent";

const MCP_CALLS: McpCallLaunch = {
  servers: { db: { type: "local", command: ["pg-mcp"] } },
  env: { TOKEN: "t" },
  placement: { kind: "container", containerId: "c1", workspaceDir: "/w" },
};

function codeStepEnvironment(
  mcpCalls: McpCallLaunch | null = MCP_CALLS,
): LaunchedRuntime & { cleanups: number } {
  const environment = {
    resolvedEnvironment: {
      source: "inline",
      runtime: { kind: "managed", id: "bun1" },
      envVars: [],
      connectors: [],
    },
    workspacePath: "/tmp/ws",
    workspaceFolder: "/workspace",
    runtimeContainerId: null,
    agent: null,
    mcpCalls: mcpCalls ?? undefined,
    cleanups: 0,
    cleanup: () => {
      environment.cleanups += 1;
      return Promise.resolve();
    },
  };
  return environment as unknown as LaunchedRuntime & { cleanups: number };
}

const signal = new AbortController().signal;

describe("dryRunStepUsesAgent", () => {
  test("only a code step launches without an agent", () => {
    expect(dryRunStepUsesAgent("code")).toBe(false);
    expect(dryRunStepUsesAgent("user_defined")).toBe(true);
    expect(dryRunStepUsesAgent("built_in")).toBe(true);
    expect(dryRunStepUsesAgent(undefined)).toBe(true);
  });
});

describe("dryRunAgentLaunchFields", () => {
  test("a code-step launch starts no agent and no fake provider", () => {
    expect(dryRunAgentLaunchFields(null)).toEqual({
      startAgent: false,
      taskKind: "code",
    });
  });

  test("an agent launch bakes in the fake provider", () => {
    const fakeAiServer = { port: 4321 } as unknown as FakeAiServer;
    const fields = dryRunAgentLaunchFields(fakeAiServer);
    expect(fields.startAgent).toBe(true);
    expect(fields.resolveFakeAiProviderOverride).toBeFunction();
  });
});

describe("createLazyFakeAiServer", () => {
  test("starts nothing until asked, and stopping then is a no-op", async () => {
    let created = 0;
    const lazy = createLazyFakeAiServer(() => {
      created += 1;
      return {} as FakeAiServer;
    });
    await lazy.stop();
    expect(created).toBe(0);
  });

  test("starts one server however often it is asked, and stops it", async () => {
    const events: string[] = [];
    const lazy = createLazyFakeAiServer(
      () =>
        ({
          start: () => {
            events.push("start");
            return Promise.resolve();
          },
          stop: () => {
            events.push("stop");
            return Promise.resolve();
          },
        }) as unknown as FakeAiServer,
    );
    const [first, second] = await Promise.all([lazy.get(), lazy.get()]);
    expect(first).toBe(second);
    await lazy.stop();
    expect(events).toEqual(["start", "stop"]);
  });
});

describe("runCodeStepDryRunChecks", () => {
  test("runs the checks through a pool over mcpCalls, then closes it", async () => {
    const fake = createFakePool((call) =>
      Promise.resolve(
        call.tool === "broken"
          ? { status: "tool_error", content: [{ type: "text", text: "boom" }] }
          : { status: "ok", content: [], structuredContent: null },
      ),
    );
    const reports = await runCodeStepDryRunChecks({
      environment: codeStepEnvironment(),
      healthChecks: [
        healthCheck({ tool: "ping", mcp: "db", args: { q: 1 } }),
        healthCheck({ tool: "broken", mcp: "db", severity: "warn" }),
      ],
      poolFactory: fake.factory,
      signal,
    });
    expect(fake.input()).toMatchObject({
      servers: MCP_CALLS.servers,
      env: MCP_CALLS.env,
      placement: MCP_CALLS.placement,
    });
    expect(
      fake.calls.map((call) => [call.serverKey, call.tool, call.args]),
    ).toEqual([
      ["db", "ping", { q: 1 }],
      ["db", "broken", {}],
    ]);
    expect(reports.map((report) => report.outcome.kind)).toEqual([
      "passed",
      "failed",
    ]);
    expect(fake.closeAllCount()).toBe(1);
  });

  test("closes the pool when a check throws", async () => {
    const fake = createFakePool(() => Promise.reject(new Error("pool broke")));
    let message = "";
    try {
      await runCodeStepDryRunChecks({
        environment: codeStepEnvironment(),
        healthChecks: [healthCheck({ tool: "ping", mcp: "db" })],
        poolFactory: fake.factory,
        signal,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("pool broke");
    expect(fake.closeAllCount()).toBe(1);
  });

  test("no checks opens no pool", async () => {
    const fake = createFakePool(() => Promise.reject(new Error("unused")));
    const reports = await runCodeStepDryRunChecks({
      environment: codeStepEnvironment(null),
      healthChecks: [],
      poolFactory: fake.factory,
      signal,
    });
    expect(reports).toEqual([]);
    expect(() => fake.input()).toThrow("pool not created");
  });

  test("checks without mcpCalls fail loudly", async () => {
    const fake = createFakePool(() => Promise.reject(new Error("unused")));
    let message = "";
    try {
      await runCodeStepDryRunChecks({
        environment: codeStepEnvironment(null),
        healthChecks: [healthCheck({ tool: "ping", mcp: "db" })],
        poolFactory: fake.factory,
        signal,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("resolved none");
  });
});

describe("runDryRunStepChecks", () => {
  test("an agent launch without the fake AI server is an internal error", async () => {
    const fake = createFakePool(() => Promise.reject(new Error("unused")));
    let message = "";
    try {
      await runDryRunStepChecks({
        server: { baseUrl: "http://x", password: "p", workspaceFolder: "/w" },
        environment: codeStepEnvironment(),
        healthChecks: [cliHealthCheck({ command: ["true"] })],
        fakeAiServer: null,
        poolFactory: fake.factory,
        signal,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("fake AI server");
  });
});

describe("a code-step dry-run launch", () => {
  test("probes no OpenCode, runs the direct checks, and tears down", async () => {
    const environment = codeStepEnvironment();
    const launches: DryRunLaunchInput[] = [];
    const fake = createFakePool(() =>
      Promise.resolve({ status: "ok", content: [], structuredContent: null }),
    );
    const outcome = await runInDryRunEnvironment({
      orchestrator: {
        launch: (input) => {
          launches.push(input);
          return Promise.resolve(environment);
        },
      },
      launchInput: {
        ...dryRunAgentLaunchFields(null),
        opencodeMcpJson: { db: { type: "local", command: ["pg-mcp"] } },
      } as unknown as DryRunLaunchInput,
      keep: false,
      run: (server, launched) =>
        runDryRunStepChecks({
          server,
          environment: launched,
          healthChecks: [healthCheck({ tool: "ping", mcp: "db" })],
          fakeAiServer: null,
          poolFactory: fake.factory,
          signal,
        }),
    });
    expect(launches[0]?.startAgent).toBe(false);
    expect(outcome).toMatchObject({
      kind: "ran",
      agentBaseUrl: null,
      health: { containerHealth: null, opencodeHealth: null, mcpServers: [] },
    });
    if (outcome.kind !== "ran") throw new Error(outcome.reason);
    expect(outcome.result.map((report) => report.outcome.kind)).toEqual([
      "passed",
    ]);
    expect(fake.closeAllCount()).toBe(1);
    expect(environment.cleanups).toBe(1);
  });
});

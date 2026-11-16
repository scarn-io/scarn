/**
 * Decision 5 on the worker: a Task's extra connectors join its environment
 * before variable resolution, their `secret` vars resolve from `.scarn/.env`
 * first and then Scarn, the MCP startup gate covers them, and the run's
 * environment diagnostics mark them `extra`.
 */
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "bun:test";
import { readEnvironmentDefinition } from "@scarn/sdk/resolve-environment";
import type { EnvironmentDefinition } from "@scarn/sdk/resolve-environment";
import { ConnectorUnavailableError } from "../../../../src/work/task-run/application/connector-unavailable-error";
import { mergeExtraConnectors } from "../../../../src/work/task-run/application/merge-extra-connectors";
import { buildEnvironmentDiagnostics } from "../../../../src/work/task-run/contracts/environment-diagnostics";
import type { TaskRunWorkerClient } from "../../../../src/work/task-run/contracts/process-project-work-types";
import type { ExtraConnector } from "../../../../src/work/task-run/contracts/task-run-contracts";
import {
  createRecordingOrchestrator,
  createRoutingDeps,
  createRunTracker,
  createWorkerClient,
  createWorkerContext,
  runClaim,
  taskRunId,
} from "./helpers/claimed-task-fixtures";

const datadogExtra: ExtraConnector = {
  connectorId: "datadog",
  vars: {
    DD_API_KEY: { secret: "DD_KEY" },
    DD_APPLICATION_KEY: { secret: "DD_APP_KEY" },
  },
};

function definitionOf(
  ref: Parameters<typeof readEnvironmentDefinition>[0],
): EnvironmentDefinition {
  const definition = readEnvironmentDefinition(ref);
  if (definition instanceof Error) throw definition;
  return definition;
}

describe("mergeExtraConnectors", () => {
  test("adds each extra's id and a secret var per required var", () => {
    const merged = mergeExtraConnectors(
      definitionOf({
        kind: "inline",
        runtime: { kind: "managed", id: "bun1" },
        connectors: ["playwright"],
      }),
      [datadogExtra],
    );

    expect(merged.connectors).toEqual(["playwright", "datadog"]);
    expect(merged.envVars).toEqual([
      {
        name: "DD_API_KEY",
        source: "secret",
        secretName: "DD_KEY",
        applies: "agent",
      },
      {
        name: "DD_APPLICATION_KEY",
        source: "secret",
        secretName: "DD_APP_KEY",
        applies: "agent",
      },
    ]);
  });

  test("keeps the environment's own var when it already gives the agent one", () => {
    const merged = mergeExtraConnectors(
      definitionOf({
        kind: "inline",
        envJson: [
          {
            name: "DD_API_KEY",
            source: "inherit",
            from: "WORKER_DD",
            secret: true,
            optional: false,
          },
        ],
      }),
      [datadogExtra],
    );

    expect(merged.envVars.map(({ name, source }) => [name, source])).toEqual([
      ["DD_API_KEY", "inherit"],
      ["DD_APPLICATION_KEY", "secret"],
    ]);
  });

  test("returns the definition unchanged with no extras", () => {
    const definition = definitionOf(null);
    expect(mergeExtraConnectors(definition, [])).toBe(definition);
  });

  test("diagnostics mark extras apart from the environment's connectors", () => {
    const merged = mergeExtraConnectors(
      definitionOf({ kind: "inline", connectors: ["playwright"] }),
      [datadogExtra],
    );
    const diagnostics = buildEnvironmentDiagnostics(
      { ...merged, runtime: { kind: "managed", id: "bun1" } },
      {
        definitionVersion: null,
        checkoutCommit: "abc",
        branch: "main",
        branches: null,
      },
      merged.envVars,
      { DD_KEY: "local" },
      ["datadog"],
    );

    expect(diagnostics.connectors).toEqual([
      { id: "playwright", source: "environment" },
      { id: "datadog", source: "extra" },
    ]);
    expect(diagnostics.vars).toEqual([
      { name: "DD_API_KEY", source: "secret:worker" },
      { name: "DD_APPLICATION_KEY", source: "secret:scarn" },
    ]);
  });
});

describe("startProcessClaimedTaskRun with extra connectors", () => {
  const previousFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = previousFetch;
    vi.restoreAllMocks();
  });

  function stubMcpList(
    servers: Array<{
      name: string;
      status: { status: string; error?: string };
    }>,
  ) {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname !== "/api/mcp") {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            location: { directory: "/workspaces/repo" },
            data: servers,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }) as typeof fetch;
  }

  async function setup(
    resolveTaskRunEnvironment: TaskRunWorkerClient["resolveTaskRunEnvironment"],
  ) {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "scarn-extra-connectors-"),
    );
    const { launch } = createRecordingOrchestrator(workspacePath);
    const workerClient = {
      ...createWorkerClient(),
      resolveTaskRunEnvironment,
    };
    workerClient.getTaskRunWorkerContext = vi.fn(() =>
      Promise.resolve(
        createWorkerContext(
          { kind: "inline", runtime: { kind: "managed", id: "bun1" } },
          null,
          { extraConnectors: [datadogExtra] },
        ),
      ),
    );
    const routing = createRoutingDeps({
      workerClient,
      workspaceOrchestrator: { launch },
    });
    const promptAsync = vi.fn(() =>
      Promise.resolve({ sessionId: "agent-session-id" }),
    );
    const deps = {
      ...routing,
      agentRunner: { ...routing.agentRunner, promptAsync },
      mcpStartupGate: { windowMs: 50, intervalMs: 5 },
    };
    return { deps, launch, promptAsync };
  }

  test("an extra's secret comes from .scarn/.env first, then Scarn", async () => {
    stubMcpList([{ name: "datadog", status: { status: "connected" } }]);
    const resolveTaskRunEnvironment = vi.fn(() =>
      Promise.resolve({
        secrets: { DD_APP_KEY: { value: "scarn-app-key", expiresAt: null } },
        missing: [],
      }),
    );
    const { deps, launch, promptAsync } = await setup(
      resolveTaskRunEnvironment,
    );

    await runClaim(deps, {
      tracker: createRunTracker(),
      localEnvVars: { DD_KEY: "local-api-key" },
    });

    expect(resolveTaskRunEnvironment).toHaveBeenCalledTimes(1);
    expect(resolveTaskRunEnvironment).toHaveBeenCalledWith({
      taskRunId,
      claimToken: "claim-token",
      secretNames: ["DD_APP_KEY"],
    });
    expect(launch.mock.calls[0]?.[0].stepEnv).toEqual({
      DD_API_KEY: "local-api-key",
      DD_APPLICATION_KEY: "scarn-app-key",
    });
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test("an extra that fails to connect fails the run before the prompt", async () => {
    stubMcpList([
      {
        name: "datadog",
        status: { status: "failed", error: "401 Unauthorized" },
      },
    ]);
    const { deps, promptAsync } = await setup(() =>
      Promise.resolve({
        secrets: {
          DD_KEY: { value: "k", expiresAt: null },
          DD_APP_KEY: { value: "a", expiresAt: null },
        },
        missing: [],
      }),
    );
    const markFailed = vi.fn(() => Promise.resolve(undefined));

    let error: unknown;
    try {
      await runClaim(deps, { tracker: { ...createRunTracker(), markFailed } });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ConnectorUnavailableError);
    expect((error as ConnectorUnavailableError).servers).toEqual([
      {
        name: "datadog",
        status: "failed",
        error: "401 Unauthorized",
        healthy: false,
      },
    ]);
    expect(promptAsync).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledTimes(1);
  });
});

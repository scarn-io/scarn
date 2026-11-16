import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "bun:test";
import { ConnectorUnavailableError } from "../../../../src/work/task-run/application/connector-unavailable-error";
import type { FakeAiServer } from "../../../../src/work/task-run/infra/fake-ai/fake-ai-server";
import type { TaskRunWorkerContext } from "../../../../src/work/task-run/contracts/process-project-work-types";
import {
  createRecordingOrchestrator,
  createRoutingDeps,
  createRunTracker,
  createWorkerClient,
  createWorkerContext,
  runClaim,
} from "./helpers/claimed-task-fixtures";

/**
 * Decision 10: before the first prompt, every connector and step `mcps`
 * server must report `connected`. Exercises the real `pollMcpStatus` against
 * a stubbed `GET /api/mcp`, with a short window so the timeout case is fast.
 */
describe("startProcessClaimedTaskRun MCP startup gate", () => {
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
    const reads = vi.fn();
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname !== "/api/mcp") {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      reads();
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
    return reads;
  }

  async function setup(context: TaskRunWorkerContext) {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "scarn-mcp-startup-gate-"),
    );
    const { launch } = createRecordingOrchestrator(workspacePath);
    const workerClient = createWorkerClient();
    workerClient.getTaskRunWorkerContext = vi.fn(() =>
      Promise.resolve(context),
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
    const markFailed = vi.fn(() => Promise.resolve(undefined));
    const tracker = { ...createRunTracker(), markFailed };
    return { deps, tracker, markFailed, promptAsync };
  }

  const withConnectorAndStepMcp = () =>
    createWorkerContext(
      {
        kind: "inline",
        runtime: { kind: "managed", id: "bun1" },
        connectors: ["playwright"],
      },
      null,
      {
        opencodeMcpJson: {
          db: { type: "remote", url: "https://db.example.com" },
        },
      },
    );

  async function runExpectingFailure(
    run: Promise<unknown>,
  ): Promise<ConnectorUnavailableError> {
    try {
      await run;
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorUnavailableError);
      return error as ConnectorUnavailableError;
    }
    throw new Error("Expected the run to fail");
  }

  test("prompts once every connector and step MCP server is connected, ignoring repo-only servers", async () => {
    stubMcpList([
      { name: "db", status: { status: "connected" } },
      { name: "playwright", status: { status: "connected" } },
      { name: "repo-only", status: { status: "disabled" } },
    ]);
    const { deps, tracker, promptAsync } = await setup(
      withConnectorAndStepMcp(),
    );

    await runClaim(deps, { tracker });

    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test("a failed server fails the run before the prompt with OpenCode's error", async () => {
    stubMcpList([
      { name: "db", status: { status: "connected" } },
      {
        name: "playwright",
        status: { status: "failed", error: "spawn npx ENOENT" },
      },
    ]);
    const { deps, tracker, markFailed, promptAsync } = await setup(
      withConnectorAndStepMcp(),
    );

    const error = await runExpectingFailure(runClaim(deps, { tracker }));

    expect(error.servers).toEqual([
      {
        name: "playwright",
        status: "failed",
        error: "spawn npx ENOENT",
        healthy: false,
      },
    ]);
    expect(error.message).toContain("playwright (failed: spawn npx ENOENT)");
    expect(promptAsync).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledTimes(1);
  });

  test("a server still pending or never listed when the window ends fails the run", async () => {
    stubMcpList([{ name: "playwright", status: { status: "pending" } }]);
    const { deps, tracker, promptAsync } = await setup(
      withConnectorAndStepMcp(),
    );

    const error = await runExpectingFailure(runClaim(deps, { tracker }));

    expect(error.servers.map(({ name, status }) => [name, status])).toEqual([
      ["db", "missing"],
      ["playwright", "pending"],
    ]);
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test("a disabled step MCP server does not count as connected", async () => {
    stubMcpList([
      { name: "db", status: { status: "disabled" } },
      { name: "playwright", status: { status: "connected" } },
    ]);
    const { deps, tracker, promptAsync } = await setup(
      withConnectorAndStepMcp(),
    );

    const error = await runExpectingFailure(runClaim(deps, { tracker }));

    expect(error.servers.map(({ name, status }) => [name, status])).toEqual([
      ["db", "disabled"],
    ]);
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test("the gate runs before declared health checks and stops their harness when it fails", async () => {
    stubMcpList([{ name: "playwright", status: { status: "needs_auth" } }]);
    const context = withConnectorAndStepMcp();
    context.runtime.healthChecksJson = [
      { kind: "tool", tool: "greet", severity: "required", timeoutSeconds: 5 },
    ];
    const { deps, tracker, promptAsync } = await setup(context);
    const stop = vi.fn(() => Promise.resolve(undefined));
    const fakeAiServer = {
      start: () => Promise.resolve(undefined),
      stop,
      port: 9999,
    } as unknown as FakeAiServer;
    const runHealthChecks = vi.fn(() => Promise.resolve([]));

    await runExpectingFailure(
      runClaim(
        { ...deps, createFakeAiServer: () => fakeAiServer, runHealthChecks },
        { tracker },
      ),
    );

    expect(runHealthChecks).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test("a run with no connectors or step MCP servers skips the gate", async () => {
    const reads = stubMcpList([]);
    const { deps, tracker, promptAsync } = await setup(createWorkerContext());

    await runClaim(deps, { tracker });

    expect(reads).not.toHaveBeenCalled();
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });
});

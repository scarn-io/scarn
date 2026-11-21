/**
 * What the `mcp_tool` branch writes to the task log (server, transport,
 * duration, outcome, arg keys, content block count, but never arg values,
 * content, env values or headers) and the size cap on its result.
 */
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { buildTaskRunFailurePayload } from "../../../../src/work/task-run/application/build-task-run-failure-payload";
import type {
  McpToolCallInput,
  McpToolCallOutcome,
} from "../../../../src/work/task-run/application/mcp-tool-caller";
import { McpToolStepError } from "../../../../src/work/task-run/application/mcp-tool-step-error";
import {
  MCP_TOOL_RESULT_MAX_BYTES,
  assertMcpToolResultWithinCap,
} from "../../../../src/work/task-run/application/mcp-tool-step-observability";
import { runMcpToolStepBranch } from "../../../../src/work/task-run/application/process-claimed-task-run-mcp-tool-branch";
import { buildFindingsSubmissionPath } from "../../../../src/work/task-run/application/process-project-work-findings";
import type {
  LaunchedRuntime,
  ProjectWorkLogger,
  TaskRunWorkerContext,
} from "../../../../src/work/task-run/contracts/process-project-work-types";
import { noopReporter } from "../../../../src/work/task-run/contracts/work-reporter";
import { captureRejection } from "../../../support/capture-rejection";
import { createMcpToolStepWorkerContext } from "./helpers/claimed-task-fixtures";

const SECRET_TOKEN = "env-secret-value-123";
const SECRET_HEADER = "Bearer header-secret-456";
const ARG_VALUE = "confidential-search-term";
const CONTENT_TEXT = "private-page-body";

let workspacePath: string;

beforeEach(async () => {
  workspacePath = await mkdtemp(path.join(os.tmpdir(), "scarn-mcp-observe-"));
});

afterEach(async () => {
  await rm(workspacePath, { recursive: true, force: true });
});

function workerContext(
  opencodeMcpJson: TaskRunWorkerContext["runtime"]["opencodeMcpJson"] = null,
): TaskRunWorkerContext {
  const context = createMcpToolStepWorkerContext();
  return {
    ...context,
    runtime: { ...context.runtime, opencodeMcpJson },
    task: { ...context.task, inputJson: { title: ARG_VALUE } },
  };
}

function environment(
  server: NonNullable<LaunchedRuntime["mcpTool"]>["servers"][string],
): LaunchedRuntime {
  return {
    workspacePath,
    mcpTool: {
      servers: { notion: server },
      env: { NOTION_TOKEN: SECRET_TOKEN },
      placement: { kind: "host", workspaceDir: "/workspace" },
    },
  } as unknown as LaunchedRuntime;
}

const remoteServer = {
  type: "remote" as const,
  url: "https://mcp.notion.example/mcp",
  headers: { Authorization: SECRET_HEADER },
};

async function settle(promise: Promise<void>): Promise<Error | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

async function runBranch(input: {
  outcome: McpToolCallOutcome;
  context?: TaskRunWorkerContext;
  server?: NonNullable<LaunchedRuntime["mcpTool"]>["servers"][string];
}) {
  const caller = {
    call: vi.fn<(call: McpToolCallInput) => Promise<McpToolCallOutcome>>(() =>
      Promise.resolve(input.outcome),
    ),
  };
  const logger = {
    debug: vi.fn<ProjectWorkLogger["debug"]>(),
    log: vi.fn<ProjectWorkLogger["log"]>(),
    error: vi.fn<ProjectWorkLogger["error"]>(),
  };
  const failure = await settle(
    runMcpToolStepBranch({
      deps: { mcpToolCaller: caller },
      logger,
      reporter: noopReporter,
      workerContext: input.context ?? workerContext(),
      environment: environment(input.server ?? remoteServer),
      taskRunId: "task-run-id",
      localRuntimeSessionId: "local-session-id",
      promptEnv: { NOTION_TOKEN: SECRET_TOKEN },
    }),
  );
  const lines = [
    ...logger.debug.mock.calls,
    ...logger.log.mock.calls,
    ...logger.error.mock.calls,
  ].map(
    ([scope, message, details]) =>
      `[${scope}] ${message} ${JSON.stringify(details ?? {})}`,
  );
  return { failure, lines, logger };
}

const okOutcome: McpToolCallOutcome = {
  status: "ok",
  content: [
    { type: "text", text: CONTENT_TEXT },
    { type: "text", text: "second" },
  ],
  structuredContent: { body: CONTENT_TEXT },
};

describe("mcp_tool task log", () => {
  test("logs the server and transport before the call, and the outcome after", async () => {
    const { logger } = await runBranch({ outcome: okOutcome });

    const messages = logger.log.mock.calls.map(([, message]) => message);
    expect(messages[0]).toBe("mcp: starting notion (remote)");
    expect(messages[1]).toMatch(
      /^mcp: notion\.search called in \d+\.\ds \(ok\)$/,
    );
    expect(logger.log.mock.calls[0]?.[2]).toMatchObject({ argKeys: ["query"] });
    expect(logger.log.mock.calls[1]?.[2]).toMatchObject({ contentBlocks: 2 });
  });

  test("never logs arg values, content, env values or headers", async () => {
    const { lines } = await runBranch({ outcome: okOutcome });

    const log = lines.join("\n");
    for (const secret of [
      SECRET_TOKEN,
      SECRET_HEADER,
      ARG_VALUE,
      CONTENT_TEXT,
    ]) {
      expect(log).not.toContain(secret);
    }
  });

  test("labels a local server local", async () => {
    const { logger } = await runBranch({
      outcome: okOutcome,
      server: { type: "local", command: ["bun", "server.ts"] },
    });

    expect(logger.log.mock.calls[0]?.[1]).toBe("mcp: starting notion (local)");
  });

  test("labels a server authored with a managed connection managed", async () => {
    const { logger } = await runBranch({
      outcome: okOutcome,
      context: workerContext({
        notion: {
          type: "ref",
          name: "notion",
          auth: { connection: "notion" },
        },
      }),
    });

    expect(logger.log.mock.calls[0]?.[1]).toBe(
      "mcp: starting notion (managed)",
    );
  });

  test.each<[McpToolCallOutcome, string]>([
    [{ status: "tool_error", content: [] }, "tool_error"],
    [
      { status: "unavailable", reason: "connect", detail: "refused" },
      "unavailable:connect",
    ],
    [{ status: "timeout" }, "timeout"],
    [{ status: "aborted" }, "aborted"],
  ])("logs a %o call as (%s)", async (outcome, label) => {
    const { logger } = await runBranch({ outcome });

    expect(logger.log.mock.calls[1]?.[1]).toEndWith(`(${label})`);
  });
});

describe("mcp_tool result cap", () => {
  test("a result over 1 MiB is McpOutputInvalid stating its size and the limit", async () => {
    const { failure } = await runBranch({
      outcome: {
        status: "ok",
        content: [
          { type: "text", text: "x".repeat(MCP_TOOL_RESULT_MAX_BYTES) },
        ],
        structuredContent: null,
      },
    });

    expect(failure).toBeInstanceOf(McpToolStepError);
    expect(buildTaskRunFailurePayload(failure).errorJson.name).toBe(
      "Scarn.McpOutputInvalid",
    );
    const message = (failure as McpToolStepError).message;
    expect(message).toContain("notion.search");
    expect(message).toContain("over the 1 MiB limit (1048576 bytes)");
    expect(message).toMatch(/returned a 1 MiB result \(\d+ bytes\)/);
    expect(
      await access(buildFindingsSubmissionPath(workspacePath)).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  test("a result at the limit passes; one byte over fails", () => {
    const atLimit = "x".repeat(MCP_TOOL_RESULT_MAX_BYTES - 2);
    expect(() => {
      assertMcpToolResultWithinCap(atLimit, "s.t");
    }).not.toThrow();
    expect(() => {
      assertMcpToolResultWithinCap(`${atLimit}x`, "s.t");
    }).toThrow(McpToolStepError);
  });

  test("measures UTF-8 bytes, not characters", async () => {
    const failure = await captureRejection(
      Promise.resolve().then(() => {
        assertMcpToolResultWithinCap("é".repeat(600_000), "s.t");
      }),
    );
    expect(failure).toBeInstanceOf(McpToolStepError);
  });
});

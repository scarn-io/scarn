/**
 * The `mcp_tool` branch with a fake `McpToolCaller`: args rendering and
 * validation, the call's timeout, and how each outcome becomes findings or a
 * named error.
 */
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { buildTaskRunFailurePayload } from "../../../../src/work/task-run/application/build-task-run-failure-payload";
import type {
  McpToolCallInput,
  McpToolCallOutcome,
} from "../../../../src/work/task-run/application/mcp-tool-caller";
import { McpToolStepError } from "../../../../src/work/task-run/application/mcp-tool-step-error";
import { DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS } from "../../../../src/work/task-run/application/mcp-tool-step-observability";
import {
  MCP_TOOL_ERROR_MESSAGE_MAX_CHARS,
  mcpToolCallTimeoutMs,
  runMcpToolStepBranch,
} from "../../../../src/work/task-run/application/process-claimed-task-run-mcp-tool-branch";
import { buildFindingsSubmissionPath } from "../../../../src/work/task-run/application/process-project-work-findings";
import {
  RunRegistry,
  type RunHandle,
} from "../../../../src/work/task-run/application/run-registry";
import { TaskRunCancelledError } from "../../../../src/work/task-run/application/task-run-cancelled-error";
import type {
  LaunchedRuntime,
  TaskRunWorkerContext,
} from "../../../../src/work/task-run/contracts/process-project-work-types";
import { noopReporter } from "../../../../src/work/task-run/contracts/work-reporter";
import type { TaskToolCall } from "../../../../src/work/task-run/contracts/task-run-contracts";
import { captureRejection } from "../../../support/capture-rejection";
import { createMcpToolStepWorkerContext } from "./helpers/claimed-task-fixtures";

const notionServer = {
  type: "remote" as const,
  url: "https://mcp.notion.example/mcp",
  timeout: { execution: 30_000 },
};

let workspacePath: string;

beforeEach(async () => {
  workspacePath = await mkdtemp(path.join(os.tmpdir(), "scarn-mcp-branch-"));
});

afterEach(async () => {
  await rm(workspacePath, { recursive: true, force: true });
});

function workerContext(
  overrides: {
    toolCall?: Partial<TaskToolCall>;
    inputJson?: unknown;
    executionTimeoutSeconds?: number | null;
  } = {},
): TaskRunWorkerContext {
  const context = createMcpToolStepWorkerContext();
  const toolCall = context.task.toolCall;
  if (!toolCall) throw new Error("fixture has no toolCall");
  return {
    ...context,
    task: {
      ...context.task,
      inputJson:
        "inputJson" in overrides ? overrides.inputJson : context.task.inputJson,
      executionTimeoutSeconds:
        overrides.executionTimeoutSeconds === undefined
          ? context.task.executionTimeoutSeconds
          : overrides.executionTimeoutSeconds,
      toolCall: { ...toolCall, ...overrides.toolCall },
    },
  };
}

const notionLaunch: NonNullable<LaunchedRuntime["mcpTool"]> = {
  servers: { notion: notionServer },
  env: { NOTION_TOKEN: "secret" },
  placement: { kind: "host", workspaceDir: "/workspace" },
};

function environment(
  mcpTool: LaunchedRuntime["mcpTool"] | null = notionLaunch,
): LaunchedRuntime {
  return {
    workspacePath,
    mcpTool: mcpTool ?? undefined,
  } as unknown as LaunchedRuntime;
}

function fakeCaller(outcome: McpToolCallOutcome) {
  return {
    call: vi.fn<(input: McpToolCallInput) => Promise<McpToolCallOutcome>>(() =>
      Promise.resolve(outcome),
    ),
  };
}

function runBranch(input: {
  outcome?: McpToolCallOutcome;
  context?: TaskRunWorkerContext;
  environment?: LaunchedRuntime;
  promptEnv?: Record<string, string>;
  run?: RunHandle;
}) {
  const caller = fakeCaller(
    input.outcome ?? { status: "ok", content: [], structuredContent: null },
  );
  const result = runMcpToolStepBranch({
    deps: { mcpToolCaller: caller },
    logger: { debug: vi.fn(), log: vi.fn(), error: vi.fn() },
    reporter: noopReporter,
    workerContext: input.context ?? workerContext(),
    environment: input.environment ?? environment(),
    taskRunId: "task-run-id",
    localRuntimeSessionId: "local-session-id",
    promptEnv: input.promptEnv ?? {},
    run: input.run,
  });
  return { caller, result };
}

async function readFindings(): Promise<unknown> {
  const raw = await readFile(
    buildFindingsSubmissionPath(workspacePath),
    "utf8",
  );
  return (JSON.parse(raw) as { findingsJson: unknown }).findingsJson;
}

async function findingsFileExists(): Promise<boolean> {
  return access(buildFindingsSubmissionPath(workspacePath)).then(
    () => true,
    () => false,
  );
}

async function expectNamedError(
  result: Promise<void>,
  name: string,
): Promise<McpToolStepError> {
  const failure = await captureRejection(result);
  expect(failure).toBeInstanceOf(McpToolStepError);
  const payload = buildTaskRunFailurePayload(failure);
  expect(payload.errorJson.name).toBe(name);
  expect(await findingsFileExists()).toBe(false);
  return failure as McpToolStepError;
}

const textBlock = (text: string) => ({ type: "text", text });

describe("runMcpToolStepBranch", () => {
  test("with an output schema, the findings are the structuredContent", async () => {
    const { result } = runBranch({
      context: workerContext({
        toolCall: {
          toolSchemas: {
            input: { type: "object" },
            output: {
              type: "object",
              properties: { count: { type: "number" } },
              required: ["count"],
            },
          },
        },
      }),
      outcome: {
        status: "ok",
        content: [textBlock("3 pages")],
        structuredContent: { count: 3 },
      },
    });
    await result;

    expect(await readFindings()).toEqual({ count: 3 });
  });

  test("without an output schema, the findings are the content result", async () => {
    const { result } = runBranch({
      outcome: {
        status: "ok",
        content: [textBlock("3 pages")],
        structuredContent: null,
      },
    });
    await result;

    expect(await readFindings()).toEqual({
      content: [textBlock("3 pages")],
      structuredContent: null,
    });
  });

  test("without an output schema, structuredContent is kept when sent", async () => {
    const { result } = runBranch({
      outcome: {
        status: "ok",
        content: [],
        structuredContent: { extra: true },
      },
    });
    await result;

    expect(await readFindings()).toEqual({
      content: [],
      structuredContent: { extra: true },
    });
  });

  const withOutputSchema = workerContext({
    toolCall: {
      toolSchemas: {
        input: { type: "object" },
        output: { type: "object", required: ["count"] },
      },
    },
  });

  test("missing structuredContent under an output schema is McpOutputInvalid", async () => {
    const { result } = runBranch({
      context: withOutputSchema,
      outcome: { status: "ok", content: [], structuredContent: null },
    });

    await expectNamedError(result, "Scarn.McpOutputInvalid");
  });

  test("structuredContent not matching the output schema is McpOutputInvalid", async () => {
    const { result } = runBranch({
      context: withOutputSchema,
      outcome: { status: "ok", content: [], structuredContent: { other: 1 } },
    });

    const error = await expectNamedError(result, "Scarn.McpOutputInvalid");
    expect(error.message).toContain("count");
  });

  test("a tool error is McpToolError carrying the joined text, capped", async () => {
    const long = "x".repeat(MCP_TOOL_ERROR_MESSAGE_MAX_CHARS + 500);
    const { result } = runBranch({
      outcome: {
        status: "tool_error",
        content: [
          textBlock("first"),
          { type: "image", data: "…" },
          textBlock(long),
        ],
      },
    });

    const error = await expectNamedError(result, "Scarn.McpToolError");
    expect(error.message.startsWith("first\nxxx")).toBe(true);
    expect(error.message).toHaveLength(MCP_TOOL_ERROR_MESSAGE_MAX_CHARS + 1);
  });

  test("an unavailable server is McpUnavailable with the detail", async () => {
    const { result } = runBranch({
      outcome: {
        status: "unavailable",
        reason: "tool_not_found",
        detail: "Unknown tool: search",
      },
    });

    const error = await expectNamedError(result, "Scarn.McpUnavailable");
    expect(error.message).toContain("tool_not_found");
    expect(error.message).toContain("Unknown tool: search");
  });

  test("a timed-out call is Scarn.Timeout", async () => {
    const { result } = runBranch({ outcome: { status: "timeout" } });

    await expectNamedError(result, "Scarn.Timeout");
  });

  test("args not matching the input schema are ArgsError, and the tool is never called", async () => {
    const { caller, result } = runBranch({
      context: workerContext({
        toolCall: {
          toolSchemas: {
            input: {
              type: "object",
              properties: { query: { type: "number" } },
            },
            output: null,
          },
        },
      }),
    });

    await expectNamedError(result, "Scarn.ArgsError");
    expect(caller.call).not.toHaveBeenCalled();
  });

  test("args rendering to a non-object are ArgsError", async () => {
    const { caller, result } = runBranch({
      context: workerContext({
        toolCall: { argsTemplate: "{{input.title}}" },
      }),
    });

    await expectNamedError(result, "Scarn.ArgsError");
    expect(caller.call).not.toHaveBeenCalled();
  });

  test("an aborted call writes no findings and throws the run's abort error", async () => {
    const runs = new RunRegistry();
    let failure: unknown;
    let caller: ReturnType<typeof fakeCaller> | undefined;
    await runs.start(
      { taskRunId: "task-run-id", projectId: "p" },
      async (run) => {
        runs.abort("task-run-id", "cancelled");
        const started = runBranch({
          outcome: { status: "aborted" },
          run,
        });
        caller = started.caller;
        failure = await captureRejection(started.result);
      },
    );

    expect(failure).toBeInstanceOf(TaskRunCancelledError);
    expect(caller?.call.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(await findingsFileExists()).toBe(false);
  });

  test("renders input and env into the args, keeping exact-token types", async () => {
    const { caller, result } = runBranch({
      context: workerContext({
        inputJson: { title: "Bug", limit: 5, tags: ["a", "b"], owner: null },
        toolCall: {
          argsTemplate: {
            query: "{{input.title}} in {{env.SPACE}} by {{input.owner}}",
            limit: "{{input.limit}}",
            tags: "{{input.tags}}",
            input: "{{input}}",
          },
        },
      }),
      promptEnv: { SPACE: "eng" },
    });
    await result;

    expect(caller.call.mock.calls[0]?.[0].args).toEqual({
      query: "Bug in eng by ",
      limit: 5,
      tags: ["a", "b"],
      input: { title: "Bug", limit: 5, tags: ["a", "b"], owner: null },
    });
  });

  test("calls the step's server with the launch's env and placement", async () => {
    const { caller, result } = runBranch({});
    await result;

    expect(caller.call.mock.calls[0]?.[0]).toMatchObject({
      server: notionServer,
      tool: "search",
      env: { NOTION_TOKEN: "secret" },
      placement: { kind: "host", workspaceDir: "/workspace" },
    });
  });

  test("the call's timeout is the smaller of the server's and the step's", async () => {
    const { caller, result } = runBranch({
      context: workerContext({ executionTimeoutSeconds: 10 }),
    });
    await result;

    expect(caller.call.mock.calls[0]?.[0].timeoutMs).toBe(10_000);
    expect(mcpToolCallTimeoutMs(30_000, 120)).toBe(30_000);
    expect(mcpToolCallTimeoutMs(undefined, 120)).toBe(120_000);
    expect(mcpToolCallTimeoutMs(30_000, null)).toBe(30_000);
    expect(mcpToolCallTimeoutMs(undefined, null)).toBe(
      DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS,
    );
  });

  test("a launch without mcpTool is an internal error, not a named one", async () => {
    const { caller, result } = runBranch({
      environment: environment(null),
    });

    const failure = await captureRejection(result);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(McpToolStepError);
    expect(buildTaskRunFailurePayload(failure).errorJson.name).toBe(
      "Scarn.StepFailed",
    );
    expect(caller.call).not.toHaveBeenCalled();
  });

  test("a server the launch did not resolve is an internal error", async () => {
    const { result } = runBranch({
      context: workerContext({ toolCall: { server: "github" } }),
    });

    const failure = await captureRejection(result);
    expect(failure).not.toBeInstanceOf(McpToolStepError);
    expect(failure.message).toContain('"github"');
  });
});

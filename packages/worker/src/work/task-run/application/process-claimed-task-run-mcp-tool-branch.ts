/**
 * The `kind === "mcp_tool"` branch of `startProcessClaimedTaskRun`: renders
 * the step's args template, calls its one MCP tool from the worker process,
 * and writes the result as the findings submission. From there the monitor's
 * no-agent path validates and completes the run exactly as for a code step.
 *
 * A failure throws an {@link McpToolStepError} naming a built-in error
 * (`Scarn.ArgsError`, `Scarn.McpToolError`, `Scarn.McpUnavailable`,
 * `Scarn.McpOutputInvalid`, `Scarn.Timeout`). An aborted call writes no
 * findings and throws the run's abort error.
 */
import Ajv from "ajv/dist/2020";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderArgsTemplate } from "@scarn/sdk/definitions/steps";
import type {
  AnyJsonObject,
  AnyJsonValue,
} from "../../../common/contracts/json";
import { SdkMcpToolCaller } from "../infra/sdk-mcp-tool-caller";
import type {
  LaunchedRuntime,
  ProcessProjectWorkDeps,
  ProjectWorkLogger,
  TaskRunWorkerContext,
  WorkReporter,
} from "../contracts/process-project-work-types";
import type { McpContentBlock, McpToolCallOutcome } from "./mcp-tool-caller";
import { McpToolStepError } from "./mcp-tool-step-error";
import {
  assertMcpToolResultWithinCap,
  DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS,
  formatMcpServerStartingLine,
  formatMcpToolCalledLine,
  mcpServerTransportLabel,
  mcpToolOutcomeContentBlocks,
  mcpToolOutcomeLabel,
} from "./mcp-tool-step-observability";
import { buildFindingsSubmissionPath } from "./process-project-work-findings";
import type { RunHandle } from "./run-registry";

/** How much of a tool's error text `Scarn.McpToolError` carries. */
export const MCP_TOOL_ERROR_MESSAGE_MAX_CHARS = 2_000;

type JsonSchema = Record<string, unknown> | boolean;

export async function runMcpToolStepBranch(input: {
  deps: Pick<ProcessProjectWorkDeps, "mcpToolCaller">;
  logger: ProjectWorkLogger;
  reporter: WorkReporter;
  workerContext: TaskRunWorkerContext;
  environment: LaunchedRuntime;
  taskRunId: string;
  localRuntimeSessionId: string;
  promptEnv: Readonly<Record<string, string>>;
  run?: RunHandle | undefined;
}): Promise<void> {
  const { workerContext, environment } = input;
  const { toolCall } = workerContext.task;
  if (!toolCall) {
    throw new Error(
      `Task ${workerContext.task.id} is kind "mcp_tool" but has no toolCall`,
    );
  }
  const launch = environment.mcpTool;
  if (!launch) {
    throw new Error(
      `Task ${workerContext.task.id} is kind "mcp_tool" but its launch resolved no MCP servers`,
    );
  }
  const server = launch.servers[toolCall.server];
  if (!server) {
    throw new Error(
      `Task ${workerContext.task.id} calls MCP server "${toolCall.server}", which its launch did not resolve`,
    );
  }

  const args = renderArgsTemplate(toolCall.argsTemplate as AnyJsonValue, {
    input: workerContext.task.inputJson,
    env: input.promptEnv,
  });
  assertArgsMatchInputSchema(args, toolCall.toolSchemas.input);

  const label = `${toolCall.server}.${toolCall.tool}`;
  const transport = mcpServerTransportLabel(
    toolCall.server,
    server,
    workerContext.runtime.opencodeMcpJson,
  );
  input.logger.log(
    "step",
    formatMcpServerStartingLine(toolCall.server, transport),
    {
      taskRunId: input.taskRunId,
      localRuntimeSessionId: input.localRuntimeSessionId,
      stepKey: workerContext.task.key,
      tool: toolCall.tool,
      argKeys: Object.keys(args),
    },
  );
  input.reporter.event({
    type: "task:agent-running",
    taskRunId: input.taskRunId,
  });

  const timeoutMs = mcpToolCallTimeoutMs(
    server.timeout?.execution,
    workerContext.task.executionTimeoutSeconds,
  );
  const caller = input.deps.mcpToolCaller ?? new SdkMcpToolCaller();
  const startedAt = performance.now();
  const outcome = await caller.call({
    server,
    placement: launch.placement,
    tool: toolCall.tool,
    args,
    env: launch.env,
    timeoutMs,
    signal: input.run?.signal ?? new AbortController().signal,
  });
  input.logger.log(
    "step",
    formatMcpToolCalledLine(
      toolCall.server,
      toolCall.tool,
      performance.now() - startedAt,
      mcpToolOutcomeLabel(outcome),
    ),
    {
      taskRunId: input.taskRunId,
      contentBlocks: mcpToolOutcomeContentBlocks(outcome),
    },
  );

  if (outcome.status === "aborted") {
    throw input.run?.abortError() ?? new Error(`MCP tool ${label} was aborted`);
  }
  const findingsJson = findingsFromOutcome(outcome, {
    label,
    outputSchema: toolCall.toolSchemas.output,
    timeoutMs,
  });
  assertMcpToolResultWithinCap(findingsJson, label);

  const findingsPath = buildFindingsSubmissionPath(environment.workspacePath);
  await mkdir(path.dirname(findingsPath), { recursive: true });
  await writeFile(findingsPath, JSON.stringify({ findingsJson }), "utf8");
  input.logger.log("step", "MCP tool task completed", {
    taskRunId: input.taskRunId,
    localRuntimeSessionId: input.localRuntimeSessionId,
  });
}

/**
 * The tighter of the server's `timeout.execution` (milliseconds) and the
 * step's `executionTimeoutSeconds`.
 */
export function mcpToolCallTimeoutMs(
  serverExecutionMs: number | undefined,
  stepExecutionTimeoutSeconds: number | null,
): number {
  const limits = [
    serverExecutionMs,
    stepExecutionTimeoutSeconds === null
      ? undefined
      : stepExecutionTimeoutSeconds * 1_000,
  ].filter((limit): limit is number => limit !== undefined);
  return limits.length === 0
    ? DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS
    : Math.min(...limits);
}

function assertArgsMatchInputSchema(
  args: AnyJsonValue,
  inputSchema: JsonSchema,
): asserts args is AnyJsonObject {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new McpToolStepError(
      "argsError",
      "The rendered tool arguments must be a JSON object",
    );
  }
  const problems = schemaProblems(inputSchema, args, "tool input schema");
  if (problems !== null) {
    throw new McpToolStepError(
      "argsError",
      `The rendered tool arguments do not match the tool's input schema: ${problems}`,
    );
  }
}

function findingsFromOutcome(
  outcome: Exclude<McpToolCallOutcome, { status: "aborted" }>,
  context: {
    label: string;
    outputSchema: JsonSchema | null;
    timeoutMs: number;
  },
): AnyJsonValue {
  switch (outcome.status) {
    case "ok": {
      if (context.outputSchema === null) {
        return {
          content: outcome.content,
          structuredContent: outcome.structuredContent,
        };
      }
      if (outcome.structuredContent === null) {
        throw new McpToolStepError(
          "outputInvalid",
          `MCP tool ${context.label} declares an output schema but returned no structuredContent`,
        );
      }
      const problems = schemaProblems(
        context.outputSchema,
        outcome.structuredContent,
        "tool output schema",
      );
      if (problems !== null) {
        throw new McpToolStepError(
          "outputInvalid",
          `MCP tool ${context.label} returned structuredContent that does not match its output schema: ${problems}`,
        );
      }
      return outcome.structuredContent;
    }
    case "tool_error":
      throw new McpToolStepError(
        "toolError",
        toolErrorMessage(context.label, outcome.content),
      );
    case "unavailable":
      throw new McpToolStepError(
        "unavailable",
        `MCP tool ${context.label} is unavailable (${outcome.reason}): ${outcome.detail}`,
      );
    case "timeout":
      throw new McpToolStepError(
        "timeout",
        `MCP tool ${context.label} timed out after ${String(context.timeoutMs)}ms`,
      );
  }
}

function toolErrorMessage(label: string, content: McpContentBlock[]): string {
  const text = content
    .flatMap((block) =>
      block.type === "text" && typeof block["text"] === "string"
        ? [block["text"]]
        : [],
    )
    .join("\n")
    .trim();
  if (text.length === 0) {
    return `MCP tool ${label} returned an error with no text content`;
  }
  return text.length > MCP_TOOL_ERROR_MESSAGE_MAX_CHARS
    ? `${text.slice(0, MCP_TOOL_ERROR_MESSAGE_MAX_CHARS)}…`
    : text;
}

/** Ajv 2020 problems of `value` against `schema`, or null when it matches. */
function schemaProblems(
  schema: JsonSchema,
  value: AnyJsonValue,
  schemaLabel: string,
): string | null {
  const ajv = new Ajv({ allErrors: true, strict: false });
  let validate: ReturnType<Ajv["compile"]>;
  try {
    validate = ajv.compile(schema);
  } catch (error) {
    throw new Error(
      `The ${schemaLabel} is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (validate(value)) return null;
  return (
    (validate.errors ?? [])
      .map(
        (issue) => `${issue.instancePath || "/"} ${issue.message ?? "invalid"}`,
      )
      .join("; ") || "validation failed"
  );
}

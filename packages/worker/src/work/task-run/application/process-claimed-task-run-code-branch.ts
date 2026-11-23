/**
 * The `kind === "code"` branch of `startProcessClaimedTaskRun`: runs the
 * step's entrypoint as a plain function in the devcontainer (the project's, or
 * for a managed runtime the worker-supplied one). No agent exists
 * for such a step, so there is no agent session to attach or report.
 *
 * A step that declares MCP servers gets an MCP bridge session for the run
 * (ADR 0016): its URL and token reach only the runner's env and the log
 * masker, and the session stops when the step ends or the run aborts. The
 * caller opens it with {@link openCodeStepMcpBridge} before the launch gates,
 * so the step's health checks warm the pool `fn` then calls through, hands it
 * to {@link runCodeStepBranch} and stops it once the step ends.
 */
import { resolveManagedRuntime } from "../../../runtime/runtime-service/domain/managed-runtimes";
import {
  mcpBridgeStepEnv,
  openMcpBridgeSession,
  type McpBridgeSession,
} from "../../../runtime/mcp-bridge/infra";
import { executeCodeStep } from "./execute-code-step";
import type { RunHandle } from "./run-registry";
import type {
  ProcessProjectWorkDeps,
  ProjectWorkLogger,
  LaunchedRuntime,
  TaskRunWorkerContext,
  WorkReporter,
} from "../contracts/process-project-work-types";

/**
 * Opens the run's MCP bridge session when the step declares MCP servers
 * (`environment.mcpCalls`, set only for a code step), registering its token
 * with the log masker; `null` otherwise. The caller must stop the session on
 * every path.
 */
export async function openCodeStepMcpBridge(input: {
  deps: ProcessProjectWorkDeps;
  logger: ProjectWorkLogger;
  workerContext: TaskRunWorkerContext;
  environment: LaunchedRuntime;
  registerSecretValues: (values: readonly string[]) => void;
  run?: RunHandle | undefined;
}): Promise<McpBridgeSession | null> {
  const mcpCalls = input.environment.mcpCalls;
  if (!mcpCalls) return null;
  const bridge = await (
    input.deps.openMcpBridgeSession ?? openMcpBridgeSession
  )({
    servers: mcpCalls.servers,
    authoredServers: input.workerContext.runtime.opencodeMcpJson,
    placement: mcpCalls.placement,
    env: mcpCalls.env,
    logger: input.logger,
    signal: input.run?.signal ?? new AbortController().signal,
  });
  input.registerSecretValues([bridge.token]);
  return bridge;
}

/** Runs the code step, giving `fn` the env for `mcpBridge` when set. */
export async function runCodeStepBranch(input: {
  deps: ProcessProjectWorkDeps;
  logger: ProjectWorkLogger;
  reporter: WorkReporter;
  workerContext: TaskRunWorkerContext;
  environment: LaunchedRuntime;
  taskRunId: string;
  localRuntimeSessionId: string;
  stepEnv: Readonly<Record<string, string>>;
  mcpBridge: McpBridgeSession | null;
}): Promise<void> {
  const { workerContext, environment, mcpBridge: bridge } = input;
  const entrypointJson = workerContext.task.entrypointJson;
  if (!entrypointJson) {
    throw new Error(
      `Task ${workerContext.task.id} is kind "code" but has no entrypointJson`,
    );
  }

  const resolvedRuntime = environment.resolvedEnvironment.runtime;
  const runtime =
    resolvedRuntime.kind === "managed"
      ? resolveManagedRuntime(resolvedRuntime.id).definition.runtime
      : undefined;

  input.logger.log("step", "Starting code task", {
    taskRunId: input.taskRunId,
    localRuntimeSessionId: input.localRuntimeSessionId,
    sourceFile: entrypointJson.sourceFile,
    stepKey: workerContext.task.key,
  });
  input.reporter.event({
    type: "task:agent-running",
    taskRunId: input.taskRunId,
  });

  await executeCodeStep(
    {
      environment: {
        workspacePath: environment.workspacePath,
        workspaceFolder: environment.workspaceFolder,
        runtimeContainerId: environment.runtimeContainerId,
      },
      entrypointJson,
      stepKey: workerContext.task.key,
      declaredErrors: workerContext.task.declaredErrors,
      runtime,
      inputJson: workerContext.task.inputJson,
      stepEnv: bridge
        ? { ...input.stepEnv, ...mcpBridgeStepEnv(bridge) }
        : input.stepEnv,
    },
    {
      runCommand: input.deps.runCodeStepCommand,
      onLog: (message, details) => {
        input.logger.log("step", message, {
          taskRunId: input.taskRunId,
          ...details,
        });
      },
    },
  );
  input.logger.log("step", "Code task completed", {
    taskRunId: input.taskRunId,
    localRuntimeSessionId: input.localRuntimeSessionId,
  });
}

/**
 * The `kind === "code"` branch of `startProcessClaimedTaskRun`: runs the
 * step's entrypoint as a plain function in the devcontainer (the project's, or
 * for a managed runtime the worker-supplied one). No agent exists
 * for such a step, so there is no agent session to attach or report.
 */
import { resolveManagedRuntime } from "../../../runtime/runtime-service/domain/managed-runtimes";
import { executeCodeStep } from "./execute-code-step";
import type {
  ProcessProjectWorkDeps,
  ProjectWorkLogger,
  TaskRuntimeEnvironment,
  TaskRunWorkerContext,
  WorkReporter,
} from "../contracts/process-project-work-types";

export async function runCodeStepBranch(input: {
  deps: ProcessProjectWorkDeps;
  logger: ProjectWorkLogger;
  reporter: WorkReporter;
  workerContext: TaskRunWorkerContext;
  environment: TaskRuntimeEnvironment;
  taskRunId: string;
  localRuntimeSessionId: string;
  stepEnv: Readonly<Record<string, string>>;
}): Promise<void> {
  const { workerContext, environment } = input;
  const entrypointJson = workerContext.task.entrypointJson;
  if (!entrypointJson) {
    throw new Error(
      `Task ${workerContext.task.id} is kind "code" but has no entrypointJson`,
    );
  }

  const { managedRuntime } = workerContext.runtime;
  const runtime = managedRuntime
    ? resolveManagedRuntime(managedRuntime).definition.runtime
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
      runtime,
      inputJson: workerContext.task.inputJson,
      stepEnv: input.stepEnv,
    },
    { runCommand: input.deps.runCodeStepCommand },
  );
  input.logger.log("step", "Code task completed", {
    taskRunId: input.taskRunId,
    localRuntimeSessionId: input.localRuntimeSessionId,
  });
}

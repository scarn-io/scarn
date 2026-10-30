import type { RepoConfig } from "@scarn/sdk/repo-config";
import type { UuidV7 } from "../../../../../src/common/contracts/uuid-v7";
import type { TaskRunWorkerContextContract } from "../../../../../src/work/task-run/contracts/task-run-contracts";

/**
 * Per-test description of the server-side behavior the work command will see.
 *
 * The fake TaskRunWorkerClient is driven entirely by this config:
 * which jobs to claim, what worker context to return for each claimed step,
 * and (separately) the AI findings the fake AI server submits.
 */
export type WorkScenarioStep = {
  taskRunId: UuidV7;
  /**
   * Worker context returned by getTaskRunWorkerContext for this step.
   * gitUrl is irrelevant (clone is faked) but must be a non-empty string.
   */
  workerContext: TaskRunWorkerContextContract;
};

export type WorkScenario = {
  projectId: UuidV7;
  /**
   * Steps the worker client will hand out in a single claim batch. After the
   * first claim the client returns [] so the polling loop terminates (with
   * `once: true`).
   */
  steps: WorkScenarioStep[];
  /** Findings JSON the fake AI agent submits via scarn-submit-step-findings. */
  findings: unknown;
};

/**
 * Builds a minimal single-step scenario whose worker context drives a real
 * task. The result schema is permissive (any object) so the
 * configured findings always validate.
 */
export function buildSingleStepScenario(input: {
  projectId: UuidV7;
  taskRunId: UuidV7;
  prompt?: string;
  resultSchemaJson?: Record<string, unknown> | null;
  findings: unknown;
  /** Repo-relative devcontainer config the step selects; `null` auto-detects. */
  devcontainerConfigPath?: string | null;
  /** The managed runtime identifier a code step runs in; `null` is not managed. */
  managedRuntime?: string | null;
  /** The step's resolved repo access; defaults to a read-write step. */
  repo?: RepoConfig;
  /** The task's additional input (the `{{input.…}}` token source). */
  inputJson?: unknown;
  /** When set, the step is `kind: "code"` and runs this entrypoint instead of prompting. */
  codeEntrypoint?: { sourceFile: string };
  /** Makes the step a steered rerun of this previous run. */
  previousRun?: TaskRunWorkerContextContract["previousRun"];
}): WorkScenario {
  const resultSchemaJson =
    input.resultSchemaJson === undefined
      ? { type: "object", additionalProperties: true }
      : input.resultSchemaJson;

  const workerContext: TaskRunWorkerContextContract = {
    projectId: input.projectId,
    gitUrl: "https://github.com/scarn-io/integration-dummy.git",
    projectOpencodeConfig: {
      relativePath: ".scarn/scarn.jsonc",
      present: false,
      commands: [],
      services: [],
    },
    task: {
      id: input.taskRunId,
      status: "running",
      kind: input.codeEntrypoint ? "code" : "agent",
      key: "integration-step",
      name: "Integration Step",
      inputJson: input.inputJson ?? null,
      executionTimeoutSeconds: 300,
      prompt: input.codeEntrypoint
        ? null
        : (input.prompt ?? "Complete the integration step."),
      entrypointJson: input.codeEntrypoint ?? null,
      resultSchemaJson,
    },
    runtime: {
      executionMode: "workspace",
      devcontainerConfigPath: input.devcontainerConfigPath ?? null,
      managedRuntime: input.managedRuntime ?? null,
      repo: input.repo ?? {
        mode: "readWrite",
        message: null,
        onPushFailure: "fail",
      },
      envJson: null,
      healthChecksJson: null,
      opencodeMcpJson: null,
    },
    agentPrompt: {
      sessionTitle: "Integration Step",
      promptText: "Complete the integration step.",
      instructionsPlaceholder: "__SCARN_STEP_INSTRUCTIONS__",
    },
    previousRun: input.previousRun ?? null,
  };

  return {
    projectId: input.projectId,
    steps: [{ taskRunId: input.taskRunId, workerContext }],
    findings: input.findings,
  };
}

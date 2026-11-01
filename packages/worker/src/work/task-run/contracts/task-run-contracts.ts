import type { EnvVarSpec } from "@scarn/sdk/env-vars";
import type { HealthCheck } from "@scarn/sdk/health-checks";
import type { RepoConfig } from "@scarn/sdk/repo-config";
import type { OpenCodeMcpServers } from "../../../common/contracts/opencode-mcp";

export type TaskRunStatus =
  | "pending"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timeout"
  | "abandoned"
  | "cancelled"
  | "skipped"
  | "yielded";

/**
 * Mirrors the server's Task kind. The worker does not depend on
 * `@scarn/core`; `task-kind-drift.test.ts` pins this union to the SDK's
 * generated API types so the two cannot drift.
 */
export type TaskKind = "agent" | "code";

/** Mirrors the server's work item permissions: what a Task's agent may change. */
export type WorkItemPermission = "self" | "children";

export type TaskRunContract = {
  id: string;
  status: TaskRunStatus;
};

export type TaskRunWorkerContextContract = {
  projectId: string;
  gitUrl: string;
  /**
   * The previous step's work branch that this (later) step must be created off
   * of, handed down by the server. Null for the first step, which is created
   * off the repo-local configured base branch or the cloned default.
   */
  baseWorkBranch?: string | null;
  projectOpencodeConfig: {
    relativePath: string;
    present: boolean;
    commands: Array<{
      name: string;
      description: string;
      run: string;
      cwd: string | null;
    }>;
    services: Array<{
      name: string;
      description: string;
      run: string;
      cwd: string | null;
      dependsOn: Array<string>;
      expose: {
        targetPort: number;
        protocol: "tcp" | "http";
      };
    }>;
  };
  task: {
    id: string;
    status: TaskRunStatus;
    /**
     * `code` tasks are plain functions instead of LLM prompts: the worker
     * skips prompt rendering/health-check-harness/`promptAsync` entirely and
     * instead resolves + imports `entrypointJson` against the target repo's
     * checkout (see `execute-code-step.ts`).
     */
    kind: TaskKind;
    key: string;
    name: string;
    inputJson: unknown;
    executionTimeoutSeconds: number | null;
    /** Null only for `kind === "code"` tasks (see `entrypointJson`). */
    prompt: string | null;
    /** `kind === "code"` only. The module holding the step, found there by `key`. */
    entrypointJson: { sourceFile: string } | null;
    resultSchemaJson: Record<string, unknown> | null;
    /** How many more turns the agent may hand to a person; null outside a pipeline run. */
    turnsRemaining?: number | null;
    workItemId?: string;
    /** Which work items the agent's work item tools may change. */
    workItemPermissions?: readonly WorkItemPermission[];
  };
  runtime: {
    /**
     * How the task runs. `workspace` (default) clones the repo and launches a
     * devcontainer with OpenCode inside it; `no_workspace` runs OpenCode
     * directly on the host with only the rendered prompt + context, no clone
     * and no container.
     */
    executionMode: "workspace" | "no_workspace";
    /**
     * Repo-relative path of the devcontainer config this `workspace` task
     * launches (see `Runtime.devcontainer({ config })`). `null` auto-detects the
     * canonical config. Never set for `no_workspace` tasks.
     */
    devcontainerConfigPath: string | null;
    /**
     * Identifier of the worker-supplied managed runtime this `code` task runs
     * in instead of a repo devcontainer (see `Runtime.managed`), or `null`.
     * Typed `string` rather than the SDK union because a server newer than
     * this worker can send an identifier it does not know; the launch then
     * fails naming it. Never set together with `devcontainerConfigPath`.
     */
    managedRuntime: string | null;
    /**
     * The resolved repository access (see `Repo` in the SDK). Never null: the
     * server resolves the runtime's default when a definition is written.
     * `no_workspace` tasks are always `none`; `workspace` tasks are
     * `readOnly` or `readWrite`.
     */
    repo: RepoConfig;
    /**
     * The declared environment variables (see `defineStep`'s `env` field).
     * `null` means none declared. Resolved once per run by `resolveStepEnv`,
     * split by each entry's `applies`: the variables injected into the agent
     * (or code step) process, and those passed to `devcontainer up`.
     */
    envJson: EnvVarSpec[] | null;
    /**
     * The declared health checks (see `defineStep`'s `healthChecks` field).
     * `null`/empty means none — a real task run then skips the health-check
     * gate entirely (#120): no fake-AI harness starts, no synthetic provider
     * is registered, launch is unchanged.
     */
    healthChecksJson: HealthCheck[] | null;
    opencodeMcpJson: OpenCodeMcpServers | null;
  };
  agentPrompt: {
    sessionTitle: string;
    promptText: string;
    instructionsPlaceholder: string;
  };
  /**
   * Set when this Task is a steered rerun of a step: the worker writes the
   * previous run's transcript and findings to these workspace-relative paths
   * (never committed). Null or absent otherwise.
   */
  previousRun?: PreviousRunContract | null;
  /**
   * Set when this Task answers the question its previous Task asked and that
   * Task saved its agent session: where to download the export, and the
   * message to send into the restored session. Null or absent otherwise; the
   * worker then prompts from `agentPrompt`, as it does when the restore fails.
   */
  restoreSession?: RestoreSessionContract | null;
};

export type RestoreSessionContract = {
  downloadUrl: string;
  message: string;
};

export type PreviousRunContract = {
  taskRunId: string;
  status: TaskRunStatus;
  transcriptRelativePath: string;
  findingsRelativePath: string;
  findingsJson: unknown;
};

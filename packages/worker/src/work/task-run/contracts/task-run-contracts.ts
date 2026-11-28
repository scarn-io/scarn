import type { Grant } from "@scarn/sdk";
import type { ResolvedEnvironmentRef } from "@scarn/sdk/environment";
import type { HealthCheck } from "@scarn/sdk/health-checks";
import type { RepoConfig } from "@scarn/sdk/repo-config";
import type { OpenCodeMcpServers } from "../../../common/contracts/opencode-mcp";

/**
 * A catalog connector one Task adds: each var `NAME` takes its value from the
 * project secret `secret`, looked up like an environment's `secret` var.
 */
export type ExtraConnector = {
  connectorId: string;
  vars: Record<string, { secret: string }>;
};

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
export type TaskKind = "agent" | "code" | "mcp_tool";

/**
 * The one MCP tool call an `mcp_tool` task makes, with no LLM: render
 * `argsTemplate` against the task input and call `tool` on `server`.
 * `toolSchemas` are the tool's schemas as the SDK captured them at authoring
 * time. `task-kind-drift.test.ts` pins this to the SDK's generated API types.
 */
export type TaskToolCall = {
  server: string;
  tool: string;
  argsTemplate: unknown;
  toolSchemas: {
    input: Record<string, unknown> | boolean;
    output: Record<string, unknown> | boolean | null;
  };
};

export type TaskRunContract = {
  id: string;
  status: TaskRunStatus;
};

/**
 * Why the server says a run lost the authority of a managed connection its
 * launch pinned.
 */
export type ManagedAuthorityLossReason =
  "disconnected" | "replaced" | "reconnect_required" | "operation_unknown";

/** A heartbeat's `managedAuthority`: `ok`, or the reason the run lost it. */
export type ManagedAuthorityStatus =
  "ok" | { lost: ManagedAuthorityLossReason };

export type TaskRunWorkerContextContract = {
  projectId: string;
  /** The project's `<ownerUsername>/<slug>` web path; null without an owner username. */
  projectPath?: string | null;
  gitUrl: string;
  /**
   * The previous step's work branch that this (later) step must be created off
   * of, handed down by the server. Null for the first step, which is created
   * off the repo-local configured base branch or the cloned default.
   */
  baseWorkBranch?: string | null;
  /**
   * The full commit this run checks out, pinned the first time a chat ran.
   * Null until pinned, and for runs that don't pin.
   */
  baseCommit?: string | null;
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
    /** `kind === "mcp_tool"` only; null for every other kind. */
    toolCall: TaskToolCall | null;
    resultSchemaJson: Record<string, unknown> | null;
    /**
     * The error names the Task's step declares, besides the built-in ones: a
     * code step's thrown `StepError` may use only these or a built-in name.
     */
    declaredErrors: string[];
    /** How many more turns the agent may hand to a person; null outside a pipeline run. */
    turnsRemaining?: number | null;
    /** Whether the agent may ask a person for more grants when it hands over. */
    grantRequests?: boolean;
    workItemId?: string;
    /** A chat's (repo conversation's) conversation; null for any other Task. */
    conversationId?: string | null;
    /** What the agent's work item tools may do, and to which work items. */
    grants: Grant[];
  };
  runtime: {
    /**
     * Where the task runs. Null uses the repository's default runtime.
     * Every runtime has a repository checkout; host has no container.
     */
    environment: ResolvedEnvironmentRef;
    /**
     * The resolved repository access (see `Repo` in the SDK). Never null: the
     * server resolves the runtime's default when a definition is written.
     * Every runtime supports `readOnly` or `readWrite` and `gitCredentials`:
     * `"auto"` (the default) opens the git credential relay when this worker
     * offers git credentials; `"none"` leaves the container without them.
     */
    repo: RepoConfig;
    /**
     * The declared health checks (see `defineStep`'s `healthChecks` field).
     * `null`/empty means none — a real task run then skips the health-check
     * gate entirely (#120): no fake-AI harness starts, no synthetic provider
     * is registered, launch is unchanged.
     */
    healthChecksJson: HealthCheck[] | null;
    opencodeMcpJson: OpenCodeMcpServers | null;
    /**
     * Catalog connectors the Task adds on top of its environment's. The
     * server guarantees their ids collide with neither the environment's
     * connectors nor the step's `mcps`.
     */
    extraConnectors: ExtraConnector[];
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

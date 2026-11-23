/**
 * What a runtime launch returns: the prepared workspace, its runtime container
 * and agent, and the work-branch commit hook.
 */
import type { ResolvedEnvironment } from "@scarn/sdk/environment";
import type { AnyJsonValue } from "../../../common/contracts/json";
import type { EnvironmentDiagnostics } from "./environment-diagnostics";
import type { AgentRuntime, McpCallLaunch } from "./launched-runtime-handles";

/**
 * Outcome of committing and pushing a step's work branch. `pushed` is `false`
 * when the push failed and `onPushFailure` is `"warn"`, so the branch is not on
 * the remote and must not be reported as the step's work branch.
 */
export type CommitAndPushWorkBranchResult = { pushed: boolean };

/**
 * Why the work branch is being committed: the step finished with validated
 * findings (`result`, rendered into the commit message), or the agent yielded
 * with a question and the branch is saved so the conversation can resume on it.
 */
export type CommitAndPushWorkBranchContext =
  { result: AnyJsonValue } | { yielded: true };

export type LaunchedRuntime = {
  environmentDiagnostics?: EnvironmentDiagnostics | undefined;
  resolvedEnvironment: ResolvedEnvironment;
  workspacePath: string;
  /**
   * Absolute path to the resolved workspace folder inside the runtime
   * container. Phase 1 populates this from the resolved devcontainer workspace
   * folder; Phase 0 only adds the field. Replaces the implicit `/workspace`
   * constant assumption.
   *
   * For `no_workspace` runs OpenCode runs directly on the host, so this is the
   * host checkout directory (there is no container).
   */
  workspaceFolder: string;
  resolvedBranch: string;
  /**
   * The `scarn/...` branch the agent commits to, created off the checked-out
   * base. `null` for read-only runs or runs without a step key.
   */
  workBranch: string | null;
  /**
   * The branch {@link workBranch} was created off of (the resolved clone branch
   * for the first step, or the previous step's work branch for later steps).
   * `null` when there is no work branch.
   */
  createdFromBranch: string | null;
  /**
   * Commit the agent's changes to {@link workBranch} and push it. Invoked while
   * the workspace still exists and the step is still `running` (before cleanup /
   * completion). Absent when there is no work branch (`readOnly` / `none` repo
   * modes or no step key). See
   * {@link CommitAndPushWorkBranchContext} for what the commit message is built
   * from. Throws when the push fails and the step's `onPushFailure` is
   * `"fail"`, which fails the step.
   */
  commitAndPushWorkBranch?:
    | ((
        ctx: CommitAndPushWorkBranchContext,
      ) => Promise<CommitAndPushWorkBranchResult>)
    | undefined;
  devcontainerConfigPath: string;
  /**
   * Single runtime container id. With the single-container model OpenCode runs
   * inside the devcontainer, so this is the devcontainer id (collapses the
   * former `devcontainerId` + `aiContainerId` pair).
   *
   * `null` for `no_workspace` runs, where OpenCode runs directly on the host as
   * a plain child process and there is no container. Callers must treat a null
   * id as "not a container" (skip container-only concerns like `docker exec`
   * health checks / log tailing).
   */
  runtimeContainerId: string | null;
  /** `null` when the launch did not start an agent. */
  agent: AgentRuntime | null;
  /** Set only for an `mcp_tool` launch: what its one tool call needs. */
  mcpTool?: McpCallLaunch | undefined;
  /**
   * Set only for a code step that declares MCP servers: what its MCP bridge
   * session serves.
   */
  mcpCalls?: McpCallLaunch | undefined;
  aiImage: string;
  networkName: string;
  /**
   * Secret values injected into the runtime container that must be redacted
   * from the log feed (the resolved provider token(s); "Path B"). Surfaced from
   * `launch` so the caller can register them with the step's log masker before
   * the in-container log tail — which can echo them — is attached. May be empty.
   */
  secretValues: readonly string[];
  checkContainerHealth?(): Promise<{
    runtimeContainerStatus: string;
  }>;
  cleanup(): Promise<void>;
};
